// Change log listing and undo. Every content write records before/after snapshots; reverting
// restores `before` (or removes the row when it was a create) and is itself recorded.
// Soft-deleted entities (wiki pages) are hidden and revealed via `deletedAt` instead, so their
// history (wiki revisions) survives a delete/undo round trip.

import type { Change, ChangeEntity, LiveEntity } from '@autologger/contract';
import { and, desc, eq, getTableColumns, isNull } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { readableShowCondition, requireSession, requireShow } from '../core/authz.ts';
import { conflict, notFound } from '../core/errors.ts';
import { type Ctx, defineOp, snapshot } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { iso, userRefs } from './map.ts';

const { changes } = schema;

// Loosely typed on purpose: undo works on any content table through its `id` column.
// biome-ignore lint/suspicious/noExplicitAny: generic over several tables
type AnyTable = PgTable & { id: any };
const TABLES: Record<
  ChangeEntity,
  { table: AnyTable; live: LiveEntity | null; softDelete?: boolean }
> = {
  event: { table: schema.events, live: 'event' },
  topic: { table: schema.topics, live: 'topic' },
  transcript_segment: { table: schema.transcriptSegments, live: 'transcript_segment' },
  dashboard: { table: schema.dashboards, live: 'dashboard' },
  wiki_page: { table: schema.wikiPages, live: null, softDelete: true },
  category: { table: schema.categories, live: null },
};

const isUniqueViolation = (e: unknown) =>
  ((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code) === '23505';

/** Turn a JSON snapshot back into insertable values (timestamps → Date, drop generated cols). */
function revive(table: PgTable, snap: Record<string, unknown>): Record<string, unknown> {
  const cols = getTableColumns(table);
  const out: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(cols)) {
    if (!(key in snap) || col.generated) continue;
    const v = snap[key];
    out[key] = col.columnType === 'PgTimestamp' && typeof v === 'string' ? new Date(v) : v;
  }
  return out;
}

async function toChanges(ctx: Ctx, rows: (typeof changes.$inferSelect)[]): Promise<Change[]> {
  const users = await userRefs(
    ctx.db,
    rows.map((r) => r.actorId),
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    actor: r.actorId ? (users.get(r.actorId) ?? null) : null,
    via: r.via,
    clientName: r.clientName,
    op: r.op,
    entity: r.entity,
    entityId: r.entityId,
    kind: r.kind,
    summary: r.summary,
    sessionId: r.sessionId,
    showId: r.showId,
    revertedAt: iso(r.revertedAt),
    revertOf: r.revertOf,
  }));
}

defineOp({
  name: 'changes.list',
  description:
    'The change log: who changed what, from where (web, mcp agent, companion), newest first. Filter by session, show or surface.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, showId, via, limit }) {
    if (sessionId) await requireSession(ctx, sessionId, 'read');
    if (showId) await requireShow(ctx, showId, 'read');
    const rows = await ctx.db
      .select()
      .from(changes)
      .where(
        and(
          readableShowCondition(ctx, changes.showId as never),
          sessionId ? eq(changes.sessionId, sessionId) : undefined,
          showId ? eq(changes.showId, showId) : undefined,
          via ? eq(changes.via, via) : undefined,
        ),
      )
      .orderBy(desc(changes.at))
      .limit(limit);
    return toChanges(ctx, rows);
  },
});

defineOp({
  name: 'changes.revert',
  description:
    'Undo one change. Only the most recent change to an item can be undone; undo newer ones first.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { changeId }) {
    const [c] = await ctx.db.select().from(changes).where(eq(changes.id, changeId));
    if (!c) throw notFound('Change');
    if (c.sessionId) await requireSession(ctx, c.sessionId, 'write');
    else await requireShow(ctx, c.showId, c.entity === 'category' ? 'manage' : 'write');
    if (c.revertedAt) throw conflict('This change was already undone.');
    const [latest] = await ctx.db
      .select({ id: changes.id })
      .from(changes)
      .where(
        and(
          eq(changes.entity, c.entity),
          eq(changes.entityId, c.entityId),
          isNull(changes.revertedAt),
        ),
      )
      .orderBy(desc(changes.at))
      .limit(1);
    if (latest?.id !== c.id)
      throw conflict('This item changed again since; undo the newer change first.');

    const { table, live, softDelete } = TABLES[c.entity];
    const idCol = table.id;
    const [current] = (await ctx.db.select().from(table).where(eq(idCol, c.entityId))) as
      | Record<string, unknown>[]
      | [];
    // A soft-deleted row still exists in the table but not for users.
    const visible = Boolean(current) && !(softDelete && current?.deletedAt);
    let restored: Record<string, unknown> | undefined;
    try {
      if (c.kind === 'create') {
        if (visible && softDelete) {
          [restored] = (await ctx.db
            .update(table)
            .set({ deletedAt: new Date() })
            .where(eq(idCol, c.entityId))
            .returning()) as Record<string, unknown>[];
        } else if (visible) {
          await ctx.db.delete(table).where(eq(idCol, c.entityId));
        }
      } else if (c.kind === 'update') {
        if (!visible) throw conflict('That item no longer exists.');
        [restored] = (await ctx.db
          .update(table)
          .set(revive(table, c.before as Record<string, unknown>))
          .where(eq(idCol, c.entityId))
          .returning()) as Record<string, unknown>[];
      } else if (softDelete && current) {
        if (visible) throw conflict('That item already exists again.');
        [restored] = (await ctx.db
          .update(table)
          .set({ ...revive(table, c.before as Record<string, unknown>), deletedAt: null })
          .where(eq(idCol, c.entityId))
          .returning()) as Record<string, unknown>[];
      } else {
        if (current) throw conflict('That item already exists again.');
        [restored] = (await ctx.db
          .insert(table)
          .values(revive(table, c.before as Record<string, unknown>))
          .returning()) as Record<string, unknown>[];
      }
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw conflict(
          'Something with the same name exists now; rename or remove it, then undo again.',
        );
      }
      throw e;
    }
    await ctx.db.update(changes).set({ revertedAt: new Date() }).where(eq(changes.id, c.id));
    const revertId = await ctx.record({
      entity: c.entity,
      entityId: c.entityId,
      kind: c.kind === 'create' ? 'delete' : c.kind === 'delete' ? 'create' : 'update',
      summary: `Undid: ${c.summary}`,
      showId: c.showId,
      sessionId: c.sessionId,
      before: snapshot(current as Record<string, unknown> | undefined),
      after: snapshot(restored),
      revertOf: c.id,
    });
    // The undo is now the latest change for the item, so undoing it again acts as redo.
    if (c.sessionId && live)
      ctx.publish(`session:${c.sessionId}`, { type: 'invalidate', entity: live });
    if (c.sessionId && c.entity === 'event')
      ctx.publish(`session:${c.sessionId}`, { type: 'invalidate', entity: 'session' });
    if (c.entity === 'category')
      ctx.publish(`show:${c.showId}`, {
        type: 'show_changed',
        showId: c.showId,
        entity: 'category',
      });
    const [out] = await toChanges(
      ctx,
      await ctx.db.select().from(changes).where(eq(changes.id, revertId)),
    );
    return out!;
  },
});
