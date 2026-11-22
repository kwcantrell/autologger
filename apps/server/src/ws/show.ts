// Live show socket: GET /ws/show/:showId (cookie auth). Pushes job and session-list changes of
// every session of the show, so the rail's jobs indicator and session list need no polling.
//
// Job and session changes are published on `session:<id>` topics (by ops and by the worker, which
// only knows the job's session), so the socket watches every topic and keeps the messages of the
// show's sessions; session-list changes made by ops also arrive as `show_changed` on `show:<id>`.
// Show-level jobs (compile, no session) publish their changes on `show:<id>` directly.
// Event changes only move a rail card's event count, so they become a throttled session-list hint:
// live logging refetches each open rail's list at most once per EVENT_HINT_MS, not per event.
// New change-log entries (of any session, or show-level ones on `show:<id>`) become a `change`
// hint for the show's change log, throttled the same way.

import type { Job, ShowClientMessage, ShowServerMessage } from '@autologger/contract';
import { eq } from 'drizzle-orm';
import { canReadShow } from '../core/authz.ts';
import { type BusMessage, subscribe, subscribeAll, type Topic } from '../core/bus.ts';
import { db, schema } from '../db/client.ts';
import { actorFromSessionToken, sessionTokenFromCookieHeader } from '../http/auth.ts';
import { heartbeat, registerWs } from './upgrade.ts';

const showIdFrom = (url: URL) => decodeURIComponent(url.pathname.slice('/ws/show/'.length));

/** Session id → its show id (null: no such session). Sessions never move between shows. */
const sessionShow = new Map<string, Promise<string | null>>();
const SESSION_SHOW_MAX = 50_000;
/** A client this far behind (bytes queued) is closed with 1013 rather than buffered forever. */
const MAX_BUFFERED = 1024 * 1024;
/** Event changes refresh the rail's event counts at most this often (first one at once). */
export const EVENT_HINT_MS = 3000;

export function showOfSession(sessionId: string): Promise<string | null> {
  const cached = sessionShow.get(sessionId);
  if (cached) return cached;
  if (sessionShow.size >= SESSION_SHOW_MAX) sessionShow.clear();
  const p = db
    .select({ showId: schema.sessions.showId })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .then(([r]) => r?.showId ?? null);
  sessionShow.set(sessionId, p);
  // Only found sessions are cached: a missing one may have been created a moment ago elsewhere.
  p.then(
    (showId) => {
      if (showId === null) sessionShow.delete(sessionId);
    },
    () => sessionShow.delete(sessionId),
  );
  return p;
}

/** What a message on a session topic means for the show socket, if anything. */
export function showMessageFor(m: BusMessage): ShowServerMessage | null {
  if (m.type === 'change' && m.entity === 'job')
    return { type: 'change', entity: 'job', op: m.op, id: m.id, data: m.data as Job | undefined };
  if (m.type === 'invalidate' && m.entity === 'job') return { type: 'invalidate', entity: 'job' };
  // Title, archive state, episode date or audio length (shown on rail cards) changed.
  if (
    (m.type === 'change' || m.type === 'invalidate') &&
    (m.entity === 'session' || m.entity === 'audio_segment')
  )
    return { type: 'invalidate', entity: 'session' };
  return null;
}

/** An event of the session was logged, edited or deleted (its rail card's count may change). */
const isEventChange = (m: BusMessage) =>
  (m.type === 'change' || m.type === 'invalidate') && m.entity === 'event';
/** An op call wrote to the change log. */
const isLogChange = (m: BusMessage) => m.type === 'invalidate' && m.entity === 'change';

/** Leading + trailing throttle: `fire` at once, then at most once per EVENT_HINT_MS. */
function throttled(fire: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let again = false;
  const hint = () => {
    if (timer) {
      again = true;
      return;
    }
    fire();
    timer = setTimeout(() => {
      timer = undefined;
      if (again) {
        again = false;
        hint();
      }
    }, EVENT_HINT_MS);
  };
  return { hint, stop: () => clearTimeout(timer) };
}

registerWs(
  '/ws/show/',
  async (ws, req, url) => {
    const showId = showIdFrom(url);
    const actor = await actorFromSessionToken(sessionTokenFromCookieHeader(req.headers.cookie));
    // The client may have gone while the actor was loading: subscribe nothing.
    if (ws.readyState !== ws.OPEN) return;
    if (!actor) return ws.close(4401, 'unauthenticated');

    const send = (m: ShowServerMessage) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED) return ws.close(1013, 'too slow');
      ws.send(JSON.stringify(m));
    };
    // Keeps pushes in publish order while a session's show is being looked up.
    let queue = Promise.resolve();
    const push = (step: () => void | Promise<void>) => {
      queue = queue.then(step).catch(() => {});
    };
    // Throttled event-count and change-log hints (see EVENT_HINT_MS).
    const events = throttled(() => send({ type: 'invalidate', entity: 'session' }));
    const log = throttled(() => send({ type: 'invalidate', entity: 'change' }));
    const stopBeat = heartbeat(ws);
    const offAll = subscribeAll((topic: Topic, m: BusMessage) => {
      if (topic === `show:${showId}`) {
        if (m.type === 'show_changed' && m.entity === 'show')
          push(() => send({ type: 'invalidate', entity: 'session' }));
        // A show-level (compile) job changed, or a session was deleted and its jobs went with it.
        else if ((m.type === 'change' || m.type === 'invalidate') && m.entity === 'job') {
          const out = showMessageFor(m);
          if (out) push(() => send(out));
        } else if (m.type === 'compilation_changed')
          push(() => send({ type: 'invalidate', entity: 'compilation' }));
        else if (isLogChange(m)) push(log.hint);
        else if (m.type === 'closed')
          push(() => {
            send({ type: 'closed', reason: m.reason });
            ws.close(4404, m.reason);
          });
        return;
      }
      if (!topic.startsWith('session:')) return;
      const out = isEventChange(m) ? 'events' : isLogChange(m) ? 'log' : showMessageFor(m);
      if (!out) return;
      const lookup = showOfSession(topic.slice('session:'.length));
      push(async () => {
        let owner: string | null;
        try {
          owner = await lookup;
        } catch {
          // Can't tell whose session it is: let the client refetch rather than miss a change.
          send({ type: 'invalidate', entity: 'job' });
          send({ type: 'invalidate', entity: 'session' });
          return;
        }
        if (owner !== showId) return;
        if (out === 'events') events.hint();
        else if (out === 'log') log.hint();
        else send(out);
      });
    });
    // Re-check access whenever the user's grants or roles change.
    const offUser = subscribe(`user:${actor.user.id}`, async () => {
      const fresh = await actorFromSessionToken(sessionTokenFromCookieHeader(req.headers.cookie));
      const ok = fresh && (await canReadShow(fresh, showId));
      if (!ok) {
        send({ type: 'closed', reason: 'access_revoked' });
        ws.close(4403, 'access_revoked');
      }
    });
    ws.on('close', () => {
      stopBeat();
      events.stop();
      log.stop();
      offAll();
      offUser();
    });
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw)) as ShowClientMessage;
        if (m.type === 'ping') send({ type: 'pong' });
      } catch {
        /* ignore */
      }
    });
    send({ type: 'hello', showId, serverTime: new Date().toISOString() });
  },
  async (req, url) => {
    const actor = await actorFromSessionToken(sessionTokenFromCookieHeader(req.headers.cookie));
    if (!actor) return 401;
    return (await canReadShow(actor, showIdFrom(url))) ? true : 404;
  },
);
