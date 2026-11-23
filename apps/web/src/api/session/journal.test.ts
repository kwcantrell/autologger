// Pushes that land while a session list is being fetched are replayed onto the response.

import type { SessionEvent } from '@autologger/contract';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { qk } from '../queries';
import { applyEntity } from './cache';
import { journaledFetch } from './journal';

const SID = 'ses_1';
const KEY = qk.events(SID);
const ev = (id: string, timecodeFrames: number, message = '') =>
  ({
    id,
    sessionId: SID,
    timecodeFrames,
    wallTime: '2026-11-23T10:00:00Z',
    message,
  }) as unknown as SessionEvent;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Start a journaled fetch of the events list whose response we control. */
function startFetch(qc: QueryClient) {
  const response = deferred<SessionEvent[]>();
  const done = qc.fetchQuery({
    queryKey: KEY,
    queryFn: ({ signal }) =>
      journaledFetch(qc, KEY, () => {
        signal.addEventListener('abort', () => response.reject(new Error('aborted')));
        return response.promise;
      }),
  });
  return { response, done };
}

const ids = (qc: QueryClient) => qc.getQueryData<SessionEvent[]>(KEY)?.map((e) => e.id);
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('journaledFetch', () => {
  it('keeps a push that lands while the first fetch is in flight', async () => {
    const qc = client();
    const { response, done } = startFetch(qc);
    applyEntity(qc, SID, { entity: 'event', op: 'upsert', id: 'b', data: ev('b', 20) });
    response.resolve([ev('a', 10)]);
    await done;
    expect(ids(qc)).toEqual(['a', 'b']);
  });

  it('replays patches in order onto a refetch of a loaded list', async () => {
    const qc = client();
    qc.setQueryData(KEY, [ev('a', 10), ev('b', 20)]);
    const { response, done } = startFetch(qc);
    applyEntity(qc, SID, { entity: 'event', op: 'delete', id: 'a' });
    applyEntity(qc, SID, { entity: 'event', op: 'upsert', id: 'c', data: ev('c', 5) });
    applyEntity(qc, SID, {
      entity: 'event',
      op: 'upsert',
      id: 'b',
      data: ev('b', 20, 'edited'),
    });
    // The server read the list before any of those changes.
    response.resolve([ev('a', 10), ev('b', 20)]);
    await done;
    expect(ids(qc)).toEqual(['c', 'b']);
    expect(qc.getQueryData<SessionEvent[]>(KEY)?.[1]).toMatchObject({ message: 'edited' });
  });

  it('forgets a fetch once its data is stored', async () => {
    const qc = client();
    const { response, done } = startFetch(qc);
    response.resolve([ev('a', 10)]);
    await done;
    // A later push patches the cache directly; nothing replays it over newer data.
    applyEntity(qc, SID, { entity: 'event', op: 'delete', id: 'a' });
    const second = startFetch(qc);
    second.response.resolve([ev('a', 10)]);
    await second.done;
    expect(ids(qc)).toEqual(['a']);
  });

  it('a cancelled fetch (hello) drops its journal; the new fetch keeps later pushes', async () => {
    const qc = client();
    qc.setQueryData(KEY, []);
    const first = startFetch(qc);
    applyEntity(qc, SID, { entity: 'event', op: 'upsert', id: 'x', data: ev('x', 1) });
    await qc.cancelQueries({ queryKey: KEY, exact: true });
    await first.done.catch(() => undefined);
    const second = startFetch(qc);
    applyEntity(qc, SID, { entity: 'event', op: 'upsert', id: 'y', data: ev('y', 2) });
    second.response.resolve([ev('x', 1)]);
    await second.done;
    expect(ids(qc)).toEqual(['x', 'y']);
  });

  it('a failed fetch drops its journal', async () => {
    const qc = client();
    const { response, done } = startFetch(qc);
    applyEntity(qc, SID, { entity: 'event', op: 'upsert', id: 'b', data: ev('b', 20) });
    response.reject(new Error('down'));
    await expect(done).rejects.toThrow('down');
    const again = startFetch(qc);
    again.response.resolve([ev('a', 10)]);
    await again.done;
    expect(ids(qc)).toEqual(['a']);
  });
});
