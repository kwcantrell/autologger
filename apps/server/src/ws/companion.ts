// Companion socket: GET /ws/companion with `Authorization: Bearer ald_…` (or `?token=`).
//
// Server → device: `state` on connect and whenever the target session, its events, the show's
// buttons or the device's target change (debounced), plus `result` for each `op` request.
// Device → server: `op` (only COMPANION_OPS; transport/events ops default to the target session)
// and `ping`.

import type { IncomingMessage } from 'node:http';
import {
  COMPANION_OPS,
  type CompanionClientMessage,
  type CompanionServerMessage,
  type CompanionState,
  type OpName,
} from '@autologger/contract';
import { and, eq, isNull } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { type BusMessage, subscribe } from '../core/bus.ts';
import { toRpcError } from '../core/errors.ts';
import { sha256 } from '../core/ids.ts';
import { type Actor, executeOp } from '../core/op.ts';
import { db, schema } from '../db/client.ts';
import { heartbeat, registerWs } from './upgrade.ts';

const { companionDevices, users } = schema;

const PUSH_DEBOUNCE_MS = 50;
const LAST_SEEN_EVERY_MS = 3 * 60_000;
/** While following the show (no explicit target), re-check which session is live this often. */
const FOLLOW_POLL_MS = 10_000;
const SESSION_OPS = new Set<string>(['transport.start', 'transport.stop', 'events.create']);

// ── online tracking (single instance) ───────────────────────

const connections = new Map<string, number>();
/** Ids of devices with at least one open socket on this instance. */
export const onlineDevices = {
  has: (deviceId: string) => (connections.get(deviceId) ?? 0) > 0,
};
const sockets = new Map<string, Set<WebSocket>>();

function markOnline(deviceId: string, ws: WebSocket) {
  connections.set(deviceId, (connections.get(deviceId) ?? 0) + 1);
  if (!sockets.has(deviceId)) sockets.set(deviceId, new Set());
  sockets.get(deviceId)!.add(ws);
}

function markOffline(deviceId: string, ws: WebSocket) {
  const n = (connections.get(deviceId) ?? 1) - 1;
  if (n <= 0) connections.delete(deviceId);
  else connections.set(deviceId, n);
  sockets.get(deviceId)?.delete(ws);
  if (sockets.get(deviceId)?.size === 0) sockets.delete(deviceId);
}

// ── auth ────────────────────────────────────────────────────

export function deviceTokenFrom(req: IncomingMessage, url: URL): string | null {
  const h = req.headers.authorization;
  if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim() || null;
  return url.searchParams.get('token') || null;
}

/** Resolve a device token to a Companion actor, or null when unknown, revoked or the user is inactive. */
export async function actorFromDeviceToken(token: string | null): Promise<Actor | null> {
  if (!token?.startsWith('ald_')) return null;
  const [row] = await db
    .select({ d: companionDevices, u: users })
    .from(companionDevices)
    .innerJoin(users, eq(users.id, companionDevices.userId))
    .where(and(eq(companionDevices.tokenHash, sha256(token)), isNull(companionDevices.revokedAt)));
  if (row?.u.status !== 'active') return null;
  const { d, u } = row;
  return {
    user: {
      id: u.id,
      email: u.email,
      name: u.name || u.email,
      isSuperadmin: u.isSuperadmin,
      status: u.status,
    },
    via: 'companion',
    clientName: d.name,
    tokenId: d.id,
    device: { id: d.id, showId: d.showId, targetSessionId: d.targetSessionId },
  };
}

const resolved = new WeakMap<IncomingMessage, Actor>();

async function touch(deviceId: string) {
  await db
    .update(companionDevices)
    .set({ lastSeenAt: new Date() })
    .where(eq(companionDevices.id, deviceId));
}

// ── socket ──────────────────────────────────────────────────

registerWs(
  '/ws/companion',
  async (ws, req, url) => {
    const actor = resolved.get(req) ?? (await actorFromDeviceToken(deviceTokenFrom(req, url)));
    if (!actor?.device) return ws.close(4401, 'unauthenticated');
    const device = actor.device;
    const deviceId = device.id;

    let closed = false;
    let state: CompanionState | null = null;
    let sessionSub: { id: string; off: () => void } | null = null;
    let pushTimer: NodeJS.Timeout | null = null;

    const send = (m: CompanionServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };

    const refresh = async (): Promise<CompanionState | null> => {
      try {
        const next = await executeOp('companion.state', {}, actor, 'companion');
        if (closed) return null;
        state = next;
        watchSession(next.session?.id ?? null);
        send({ type: 'state', state: next, serverTime: new Date().toISOString() });
        return next;
      } catch (e) {
        const err = toRpcError(e);
        if (err.code === 'not_found' || err.code === 'forbidden') ws.close(4403, 'access_revoked');
        return null;
      }
    };

    const schedulePush = () => {
      if (closed || pushTimer) return;
      pushTimer = setTimeout(() => {
        pushTimer = null;
        void refresh();
      }, PUSH_DEBOUNCE_MS);
    };

    const onSessionMessage = (m: BusMessage) => {
      if (m.type === 'transport' || m.type === 'closed') return schedulePush();
      if (
        (m.type === 'change' || m.type === 'invalidate') &&
        (m.entity === 'event' || m.entity === 'session')
      ) {
        schedulePush();
      }
    };

    function watchSession(sessionId: string | null) {
      if (sessionSub?.id === sessionId) return;
      sessionSub?.off();
      sessionSub = sessionId
        ? { id: sessionId, off: subscribe(`session:${sessionId}`, onSessionMessage) }
        : null;
    }

    const offShow = subscribe(`show:${device.showId}`, async (m) => {
      if (m.type !== 'show_changed') return;
      if (m.entity === 'device') {
        const [row] = await db
          .select()
          .from(companionDevices)
          .where(eq(companionDevices.id, deviceId));
        if (!row || row.revokedAt) {
          ws.close(4403, 'revoked');
          return;
        }
        if (row.targetSessionId === device.targetSessionId) return;
        device.targetSessionId = row.targetSessionId;
      }
      schedulePush();
    });

    const stopBeat = heartbeat(ws);
    const seen = setInterval(() => void touch(deviceId).catch(() => {}), LAST_SEEN_EVERY_MS);
    const follow = setInterval(() => {
      if (!device.targetSessionId) void refresh();
    }, FOLLOW_POLL_MS);
    markOnline(deviceId, ws);

    ws.on('close', () => {
      closed = true;
      if (pushTimer) clearTimeout(pushTimer);
      clearInterval(seen);
      clearInterval(follow);
      stopBeat();
      offShow();
      sessionSub?.off();
      markOffline(deviceId, ws);
    });

    ws.on('message', async (raw) => {
      let m: CompanionClientMessage;
      try {
        m = JSON.parse(String(raw)) as CompanionClientMessage;
      } catch {
        return;
      }
      if (m.type === 'ping') return send({ type: 'pong' });
      if (m.type !== 'op' || typeof m.reqId !== 'string') return;
      const { reqId, op } = m;
      try {
        if (!(COMPANION_OPS as readonly string[]).includes(op)) {
          return send({
            type: 'result',
            reqId,
            ok: false,
            error: { code: 'not_found', message: `Unknown op ${op}.` },
          });
        }
        // A revoked device must not act even before the revoke notice reaches this socket.
        if (!(await actorStillValid(deviceId))) {
          send({
            type: 'result',
            reqId,
            ok: false,
            error: { code: 'unauthenticated', message: 'Device revoked.' },
          });
          return ws.close(4403, 'revoked');
        }
        let input = (
          m.input && typeof m.input === 'object' ? { ...(m.input as object) } : {}
        ) as Record<string, unknown>;
        if (SESSION_OPS.has(op) && !input.sessionId) {
          const current = state ?? (await refresh());
          const sessionId = current?.session?.id;
          if (!sessionId) {
            return send({
              type: 'result',
              reqId,
              ok: false,
              error: {
                code: 'conflict',
                message:
                  'No session to control: create a session in this show or pick one for the device.',
              },
            });
          }
          input = { ...input, sessionId };
        }
        const data = await executeOp(op as OpName, input, actor, 'companion');
        send({ type: 'result', reqId, ok: true, data });
      } catch (e) {
        send({ type: 'result', reqId, ok: false, error: toRpcError(e) });
      }
    });

    void touch(deviceId).catch(() => {});
    await refresh();
  },
  async (req, url) => {
    const actor = await actorFromDeviceToken(deviceTokenFrom(req, url));
    if (!actor) return 401;
    resolved.set(req, actor);
    return true;
  },
);

async function actorStillValid(deviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: companionDevices.id })
    .from(companionDevices)
    .innerJoin(users, eq(users.id, companionDevices.userId))
    .where(
      and(
        eq(companionDevices.id, deviceId),
        isNull(companionDevices.revokedAt),
        eq(users.status, 'active'),
      ),
    );
  return Boolean(row);
}
