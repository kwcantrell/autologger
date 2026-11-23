// Live session socket: GET /ws/session/:sessionId (cookie auth). Pushes changes to the browser.

import type {
  Session,
  SessionClientMessage,
  SessionServerMessage,
  ShowAccess,
} from '@autologger/contract';
import { canReadSession, sessionAccess } from '../core/authz.ts';
import { subscribe } from '../core/bus.ts';
import { actorFromSessionToken, sessionTokenFromCookieHeader } from '../http/auth.ts';
import { heartbeat, registerWs } from './upgrade.ts';

const sessionIdFrom = (url: URL) => decodeURIComponent(url.pathname.slice('/ws/session/'.length));

/**
 * Session payloads are published once, with the writer's `access`; each viewer gets their own.
 */
export function withViewerAccess(
  m: SessionServerMessage,
  access: ShowAccess,
): SessionServerMessage {
  if (m.type === 'transport') return { ...m, session: { ...m.session, access } };
  if (m.type === 'change' && m.entity === 'session' && m.data)
    return { ...m, data: { ...(m.data as Session), access } };
  return m;
}

registerWs(
  '/ws/session/',
  async (ws, req, url) => {
    const sessionId = sessionIdFrom(url);
    const actor = await actorFromSessionToken(sessionTokenFromCookieHeader(req.headers.cookie));
    // The client may have gone while the actor was loading: subscribe nothing.
    if (ws.readyState !== ws.OPEN) return;
    if (!actor) return ws.close(4401, 'unauthenticated');
    let access = await sessionAccess(actor, sessionId);
    if (ws.readyState !== ws.OPEN) return;
    if (!access) return ws.close(4404, 'not_found');

    const send = (m: SessionServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    const stopBeat = heartbeat(ws);
    const offSession = subscribe(`session:${sessionId}`, (m) => {
      if (
        m.type === 'access_changed' ||
        m.type === 'show_changed' ||
        m.type === 'compilation_changed'
      )
        return;
      send(withViewerAccess(m, access!));
      if (m.type === 'closed') ws.close(4404, m.reason);
    });
    // Re-check access whenever the user's grants or roles change.
    const offUser = subscribe(`user:${actor.user.id}`, async () => {
      const fresh = await actorFromSessionToken(sessionTokenFromCookieHeader(req.headers.cookie));
      const next = fresh && (await sessionAccess(fresh, sessionId));
      if (next) {
        // The cached session carries the old level: have the client refetch it.
        if (next !== access) send({ type: 'invalidate', entity: 'session' });
        access = next;
      } else {
        send({ type: 'closed', reason: 'access_revoked' });
        ws.close(4403, 'access_revoked');
      }
    });
    ws.on('close', () => {
      stopBeat();
      offSession();
      offUser();
    });
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw)) as SessionClientMessage;
        if (m.type === 'ping') send({ type: 'pong' });
      } catch {
        /* ignore */
      }
    });
    send({ type: 'hello', sessionId, serverTime: new Date().toISOString() });
  },
  async (req, url) => {
    const actor = await actorFromSessionToken(sessionTokenFromCookieHeader(req.headers.cookie));
    if (!actor) return 401;
    return (await canReadSession(actor, sessionIdFrom(url))) ? true : 404;
  },
);
