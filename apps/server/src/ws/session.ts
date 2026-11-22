// Live session socket: GET /ws/session/:sessionId (cookie auth). Pushes changes to the browser.

import type { SessionClientMessage, SessionServerMessage } from '@autologger/contract';
import { canReadSession } from '../core/authz.ts';
import { subscribe } from '../core/bus.ts';
import { actorFromSessionToken, sessionTokenFromCookieHeader } from '../http/auth.ts';
import { heartbeat, registerWs } from './upgrade.ts';

const sessionIdFrom = (url: URL) => decodeURIComponent(url.pathname.slice('/ws/session/'.length));

registerWs(
  '/ws/session/',
  async (ws, req, url) => {
    const sessionId = sessionIdFrom(url);
    const actor = await actorFromSessionToken(sessionTokenFromCookieHeader(req.headers.cookie));
    // The client may have gone while the actor was loading: subscribe nothing.
    if (ws.readyState !== ws.OPEN) return;
    if (!actor) return ws.close(4401, 'unauthenticated');

    const send = (m: SessionServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    const stopBeat = heartbeat(ws);
    const offSession = subscribe(`session:${sessionId}`, (m) => {
      if (m.type === 'access_changed' || m.type === 'show_changed') return;
      send(m);
      if (m.type === 'closed') ws.close(4404, m.reason);
    });
    // Re-check access whenever the user's grants or roles change.
    const offUser = subscribe(`user:${actor.user.id}`, async () => {
      const fresh = await actorFromSessionToken(sessionTokenFromCookieHeader(req.headers.cookie));
      const ok = fresh && (await canReadSession(fresh, sessionId));
      if (!ok) {
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
