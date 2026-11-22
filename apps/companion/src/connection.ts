// WebSocket client for /ws/companion with reconnect/backoff and request/response matching.

import WebSocket from 'ws';
import type { CompanionOp, CompanionState, RpcError, ServerMessage } from './state.js';

export type ConnectionStatus = 'connecting' | 'ok' | 'bad_token' | 'error';

export interface ConnectionEvents {
  onState(state: CompanionState, serverTime: string): void;
  onStatus(status: ConnectionStatus, message?: string): void;
  onLog?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export class OpError extends Error {
  readonly code: string;
  constructor(err: RpcError) {
    super(err.message);
    this.code = err.code;
  }
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8000;
/** Server pings every 25 s; treat 70 s of silence as a dead link. */
const IDLE_TIMEOUT_MS = 70_000;

/** Exponential backoff with ±20 % jitter. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + random() * 0.4));
}

export class CompanionConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private reqSeq = 0;
  private pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly events: ConnectionEvents,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.retryTimer = this.idleTimer = null;
    this.failPending(new Error('Connection closed'));
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Run a companion op on the server. Transport/event ops default to the device's target session. */
  request<T = unknown>(op: CompanionOp, input: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected to AutoLogger'));
    const reqId = String(++this.reqSeq);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`${op} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ type: 'op', reqId, op, input }));
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.events.onStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, { headers: { authorization: `Bearer ${this.token}` }, handshakeTimeout: 10_000 });
    } catch (e) {
      this.events.onStatus('error', `Invalid server URL: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;
    let authFailed = false;

    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        authFailed = true;
        this.events.onStatus('bad_token', 'Device token invalid or revoked');
      } else {
        this.events.onStatus('error', `Server answered HTTP ${res.statusCode}`);
      }
      ws.terminate();
    });
    ws.on('open', () => {
      this.attempt = 0;
      this.bumpIdle();
      this.events.onLog?.('info', `Connected to ${this.url}`);
    });
    ws.on('ping', () => this.bumpIdle());
    ws.on('message', (raw) => {
      this.bumpIdle();
      let m: ServerMessage;
      try {
        m = JSON.parse(String(raw)) as ServerMessage;
      } catch {
        return;
      }
      if (m.type === 'state') {
        this.events.onStatus('ok');
        this.events.onState(m.state, m.serverTime);
      } else if (m.type === 'result') {
        const p = this.pending.get(m.reqId);
        if (!p) return;
        this.pending.delete(m.reqId);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.data);
        else p.reject(new OpError(m.error));
      }
    });
    ws.on('error', (e) => {
      if (!authFailed) this.events.onStatus('error', e.message || 'Cannot reach AutoLogger');
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.failPending(new Error('Connection lost'));
      if (code === 4401 || code === 4403) {
        authFailed = true;
        this.events.onStatus('bad_token', `Device token ${String(reason) === 'revoked' ? 'revoked' : 'rejected'}`);
      }
      // A rejected token will not start working by itself: wait for new config.
      if (authFailed || this.stopped) return;
      if (code !== 1006) this.events.onStatus('error', `Disconnected (${code})`);
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = backoffDelay(this.attempt++);
    this.events.onLog?.('debug', `Reconnecting in ${delay} ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private bumpIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.ws?.terminate(), IDLE_TIMEOUT_MS);
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
