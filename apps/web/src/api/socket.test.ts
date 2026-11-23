// The shared live socket: hello/catch-up, terminal closes, backoff, probe and give-up rules.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveSocket, type LiveSocketOptions, type ShowLiveStatus } from './socket';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  // test helpers
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  push(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code = 1006) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket;

type Msg = { type: string; reason?: string };

function start(extra: Partial<LiveSocketOptions<Msg>> = {}) {
  const statuses: ShowLiveStatus[] = [];
  const hellos: { reconnect: boolean }[] = [];
  const messages: Msg[] = [];
  const socket = createLiveSocket<Msg>({
    url: 'ws://test/ws/x',
    onStatus: (s) => statuses.push(s),
    onHello: (_m, ctx) => hellos.push(ctx),
    onMessage: (m) => messages.push(m),
    ...extra,
  });
  return { socket, statuses, hellos, messages, status: () => statuses[statuses.length - 1] };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createLiveSocket', () => {
  it('opens on hello, passes messages on, and reports the first hello as not a reconnect', () => {
    const t = start();
    expect(t.status()).toEqual({ state: 'connecting' });
    last().open();
    last().push({ type: 'hello' });
    last().push({ type: 'change' });
    expect(t.status()).toEqual({ state: 'open' });
    expect(t.hellos).toEqual([expect.objectContaining({ reconnect: false })]);
    expect(t.messages).toEqual([{ type: 'change' }]);
  });

  it('reconnects with backoff after a drop and marks the next hello as a reconnect', () => {
    const t = start();
    last().open();
    last().push({ type: 'hello' });
    last().drop();
    expect(t.status()).toEqual({ state: 'reconnecting', attempt: 1 });
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(20_000);
    expect(FakeSocket.all).toHaveLength(2);
    last().open();
    last().push({ type: 'hello' });
    expect(t.hellos[1]).toMatchObject({ reconnect: true });
    expect(t.status()).toEqual({ state: 'open' });
  });

  it('stops for good on a closed message, 4401, 4403 and 4404', () => {
    const closed = start({ onClosed: vi.fn() });
    last().push({ type: 'closed', reason: 'deleted' });
    expect(closed.status()).toEqual({ state: 'closed', reason: 'deleted' });
    last().drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);

    const signedOut = start();
    last().drop(4401);
    expect(signedOut.status()).toEqual({ state: 'closed', reason: 'unauthenticated' });

    for (const code of [4403, 4404]) {
      const before = FakeSocket.all.length;
      start();
      last().drop(code);
      vi.advanceTimersByTime(60_000);
      expect(FakeSocket.all).toHaveLength(before + 1);
    }
  });

  it('probes from the second failed reconnect and stops when the resource is gone', async () => {
    const probe = vi.fn(async () => 'gone' as const);
    start({ probe });
    last().drop();
    expect(probe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    last().drop();
    expect(probe).toHaveBeenCalledOnce();
    await vi.runOnlyPendingTimersAsync();
    const count = FakeSocket.all.length;
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(count);
  });

  it('a probe that finds the server still down keeps reconnecting', async () => {
    const probe = vi.fn(async () => null);
    start({ probe });
    last().drop();
    vi.advanceTimersByTime(20_000);
    last().drop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('stops retrying after maxFailedConnects, until the browser comes back online', () => {
    const t = start({ maxFailedConnects: 2 });
    last().drop();
    vi.advanceTimersByTime(20_000);
    last().drop();
    expect(t.status()).toEqual({ state: 'closed', reason: 'unavailable' });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(2);
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.all).toHaveLength(3);
    last().open();
    last().push({ type: 'hello' });
    expect(t.status()).toEqual({ state: 'open' });
  });

  it('retries at once when the browser comes back online; dispose stops everything', () => {
    const t = start();
    last().drop();
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.all).toHaveLength(2);
    t.socket.dispose();
    last().drop();
    vi.advanceTimersByTime(60_000);
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('pings while open', () => {
    start();
    last().open();
    vi.advanceTimersByTime(25_000);
    expect(last().sent).toEqual([JSON.stringify({ type: 'ping' })]);
  });
});
