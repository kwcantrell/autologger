// Companion devices: hardware controllers bound to a user and one show.
//
// A device token (`ald_…`) is shown once at creation and stored as a SHA-256 hash. The device acts
// as the user who created it, limited to its show and never above 'write' (see core/authz.ts).

import type { CompanionDevice, CompanionState } from '@autologger/contract';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { requireSession, requireShow, showAccessMap } from '../core/authz.ts';
import { forbidden, notFound } from '../core/errors.ts';
import { newId, newSecret, sha256 } from '../core/ids.ts';
import { type Ctx, defineOp } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { onlineDevices } from '../ws/companion.ts';
import { iso } from './map.ts';
import { getSession } from './sessions.ts';
import { listCategories } from './shows.ts';

const { companionDevices, shows, sessions, events } = schema;

type DeviceRow = typeof companionDevices.$inferSelect;

function toDevice(r: DeviceRow): CompanionDevice {
  return {
    id: r.id,
    name: r.name,
    showId: r.showId,
    targetSessionId: r.targetSessionId,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: iso(r.lastSeenAt),
    online: onlineDevices.has(r.id),
  };
}

/** A live (not revoked) device the actor may administer with at least `need` on its show. */
async function loadDevice(ctx: Ctx, deviceId: string, need: 'write' | 'manage'): Promise<DeviceRow> {
  if (ctx.actor.device) throw forbidden();
  const [row] = await ctx.db
    .select()
    .from(companionDevices)
    .where(and(eq(companionDevices.id, deviceId), isNull(companionDevices.revokedAt)));
  if (!row) throw notFound('Device');
  try {
    await requireShow(ctx, row.showId, need);
  } catch (e) {
    if ((e as { code?: string }).code === 'not_found') throw notFound('Device');
    throw e;
  }
  return row;
}

defineOp({
  name: 'companion.list',
  description: 'Companion devices of a show, or of every show you manage.',
  kind: 'read',
  surfaces: ['web'],
  async run(ctx, { showId }) {
    if (ctx.actor.device) throw forbidden();
    let showIds: string[];
    if (showId) {
      await requireShow(ctx, showId, 'manage');
      showIds = [showId];
    } else {
      const all = await ctx.db.select().from(shows);
      const access = await showAccessMap(ctx, all);
      showIds = [...access].filter(([, a]) => a === 'manage').map(([id]) => id);
    }
    if (showIds.length === 0) return [];
    const rows = await ctx.db
      .select()
      .from(companionDevices)
      .where(and(inArray(companionDevices.showId, showIds), isNull(companionDevices.revokedAt)))
      .orderBy(desc(companionDevices.createdAt));
    return rows.map(toDevice);
  },
});

defineOp({
  name: 'companion.create',
  description: 'Create a Companion device for a show. The token is returned once; paste it into the Companion module.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { showId, name }) {
    if (ctx.actor.device) throw forbidden();
    await requireShow(ctx, showId, 'manage');
    const token = newSecret('ald');
    const [row] = await ctx.db
      .insert(companionDevices)
      .values({
        id: newId('dev'),
        userId: ctx.actor.user.id,
        showId,
        name,
        tokenHash: sha256(token),
        prefix: token.slice(0, 10),
      })
      .returning();
    ctx.publish(`show:${showId}`, { type: 'show_changed', showId, entity: 'device' });
    return { device: toDevice(row!), token };
  },
});

defineOp({
  name: 'companion.revoke',
  description: 'Revoke a Companion device. Its token stops working and any open connection is closed.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { deviceId }) {
    const row = await loadDevice(ctx, deviceId, 'manage');
    await ctx.db.update(companionDevices).set({ revokedAt: new Date() }).where(eq(companionDevices.id, deviceId));
    ctx.publish(`show:${row.showId}`, { type: 'show_changed', showId: row.showId, entity: 'device' });
    return { revoked: true };
  },
});

defineOp({
  name: 'companion.setTarget',
  description: 'Choose the session a Companion device controls (null = follow the show’s live or newest session).',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { deviceId, sessionId }) {
    const row = await loadDevice(ctx, deviceId, 'write');
    if (sessionId) {
      const { session } = await requireSession(ctx, sessionId, 'write');
      if (session.showId !== row.showId) throw notFound('Session');
    }
    const [after] = await ctx.db
      .update(companionDevices)
      .set({ targetSessionId: sessionId })
      .where(eq(companionDevices.id, deviceId))
      .returning();
    ctx.publish(`show:${row.showId}`, { type: 'show_changed', showId: row.showId, entity: 'device' });
    return toDevice(after!);
  },
});

/** The session a device acts on: its explicit target, else the show's rolling session, else the newest one. */
export async function resolveTargetSessionId(ctx: Ctx, device: { showId: string; targetSessionId: string | null }) {
  if (device.targetSessionId) return device.targetSessionId;
  const [row] = await ctx.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.showId, device.showId), isNull(sessions.archivedAt)))
    .orderBy(desc(sessions.isRolling), desc(sessions.createdAt))
    .limit(1);
  return row?.id ?? null;
}

defineOp({
  name: 'companion.state',
  description: 'Current state for the calling Companion device: show, target session transport, event buttons and last event.',
  kind: 'read',
  surfaces: ['companion'],
  async run(ctx) {
    const actorDevice = ctx.actor.device;
    if (!actorDevice) throw forbidden('Only Companion devices can call this.');
    const [device] = await ctx.db
      .select()
      .from(companionDevices)
      .where(and(eq(companionDevices.id, actorDevice.id), isNull(companionDevices.revokedAt)));
    if (!device) throw notFound('Device');
    const { show } = await requireShow(ctx, device.showId, 'read');
    const sessionId = await resolveTargetSessionId(ctx, device);
    const s = sessionId ? await getSession(ctx, sessionId) : undefined;
    let lastEvent: CompanionState['lastEvent'] = null;
    if (s) {
      const [e] = await ctx.db
        .select({ id: events.id, category: events.category, message: events.message, timecodeFrames: events.timecodeFrames })
        .from(events)
        .where(eq(events.sessionId, s.id))
        .orderBy(desc(events.createdAt))
        .limit(1);
      lastEvent = e ?? null;
    }
    return {
      device: { id: device.id, name: device.name },
      show: { id: show.id, name: show.name },
      session: s
        ? {
            id: s.id,
            title: s.title,
            isRolling: s.isRolling,
            rollStartedAt: s.rollStartedAt,
            elapsedFrames: s.elapsedFrames,
            take: s.take,
            frameRate: s.frameRate,
            startOffsetFrames: s.startOffsetFrames,
            eventCount: s.eventCount,
          }
        : null,
      categories: await listCategories(ctx, show.id),
      lastEvent,
    };
  },
});
