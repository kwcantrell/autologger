// Change log listing and undo. Every content write records before/after snapshots; reverting
// restores `before` (or removes the row when it was a create) and is itself recorded.
// All changes one op call records share a group id, so a bulk call can be undone in one step.
// Soft-deleted entities (wiki pages) are hidden and revealed via `deletedAt` instead, so their
// history (wiki revisions) survives a delete/undo round trip.

import type { Change, ChangeEntity, LiveEntity } from '@autologger/contract';
import {
  and,
  type Column,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  not,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { alias, type PgTable } from 'drizzle-orm/pg-core';
import { readableShowCondition, requireSession, requireShow } from '../core/authz.ts';
import { conflict, notFound } from '../core/errors.ts';
import { type Ctx, defineOp, snapshot } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { iso, userRefs } from './map.ts';
import { type Clock, clockOf, publishSession, rescaleElapsed } from './sessions.ts';
import { indexWikiLinks } from './wiki.ts';

const { changes } = schema;

// Loosely typed on purpose: undo works on any content table through its `id` column.
// biome-ignore lint/suspicious/noExplicitAny: generic over several tables
type AnyTable = PgTable & { id: any };
const TABLES: Record<
  ChangeEntity,
  {
    table: AnyTable;
    live: LiveEntity | null;
    softDelete?: boolean;
    /** Keep derived rows (an index) in step with a row an undo wrote back. */
    reindex?: (db: Ctx['db'], row: Record<string, unknown>) => Promise<void>;
  }
> = {
  event: { table: schema.events, live: 'event' },
  topic: { table: schema.topics, live: 'topic' },
  transcript_segment: { table: schema.transcriptSegments, live: 'transcript_segment' },
  dashboard: { table: schema.dashboards, live: 'dashboard' },
  wiki_page: {
    table: schema.wikiPages,
    live: null,
    softDelete: true,
    reindex: (db, row) => indexWikiLinks(db, row.id as string, row.bodyMd as string),
  },
  category: { table: schema.categories, live: null },
  // Here only for typing and `live`: clock changes snapshot just the clock fields and are undone
  // by undoClockChange, never through the generic path below.
  session: { table: schema.sessions, live: 'session' },
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

type ChangeRow = typeof changes.$inferSelect;

/**
 * True for a `changes` row that undoes a change newer than `than` and leaves the item back where
 * it was before that newer change, so it does not block undoing an older change. Follows the
 * `revert_of` chain to its root (the original, non-undo change): an odd number of undos (undo,
 * undo of a redo, …) puts the item back at the root's `before`; an even number (a redo) re-applies
 * the root, which still blocks. Every link but the live head is already undone.
 */
function cancelsNewer(than: SQL | Column): SQL {
  return sql`exists (
    with recursive chain(id, revert_of, depth) as (
      select o.id, o.revert_of, 1 from changes o where o.id = ${changes.revertOf}
      union all
      select p.id, p.revert_of, chain.depth + 1 from changes p join chain on p.id = chain.revert_of
    )
    select 1 from chain join changes root on root.id = chain.id
    where chain.revert_of is null and chain.depth % 2 = 1 and root.at > ${than}
  )`;
}

async function toChanges(
  ctx: Ctx,
  rows: (ChangeRow & { groupSize?: number; groupUndone?: number; groupTotal?: number })[],
): Promise<Change[]> {
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
    groupId: r.groupId,
    ...((r.groupSize ?? 0) > 1 || (r.groupTotal ?? 0) > 1
      ? {
          groupSize: r.groupSize,
          groupUndone: r.groupUndone,
          ...(r.groupTotal !== r.groupSize ? { groupTotal: r.groupTotal } : {}),
        }
      : {}),
  }));
}

defineOp({
  name: 'changes.list',
  description:
    'The change log: who changed what, from where (web, mcp agent, companion), newest first. Filter by session, show, surface or groupId. Every change one op call wrote shares a groupId (a bulk call such as transcript_renameSpeaker writes one change per segment). grouped: true (needs sessionId or showId) folds each group into one row — its newest change, with groupSize (how many changes match the filter, set when the group has more than one), groupUndone (how many of those are already undone) and, when the group also reaches other sessions, groupTotal (its size everywhere); revertedAt is then set only when the whole group is undone, and limit counts rows. Undo one change with changes_revert(changeId) or a whole op call with changes_revertGroup(groupId).',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, showId, via, groupId, grouped, limit }) {
    if (sessionId) await requireSession(ctx, sessionId, 'read');
    if (showId) await requireShow(ctx, showId, 'read');
    const where = and(
      readableShowCondition(ctx, changes.showId as never),
      sessionId ? eq(changes.sessionId, sessionId) : undefined,
      showId ? eq(changes.showId, showId) : undefined,
      via ? eq(changes.via, via) : undefined,
      groupId ? eq(changes.groupId, groupId) : undefined,
    );
    if (!grouped) {
      const rows = await ctx.db
        .select()
        .from(changes)
        .where(where)
        .orderBy(desc(changes.at))
        .limit(limit);
      return toChanges(ctx, rows);
    }
    // One row per group (changes without a group stand alone): the newest change, plus counts.
    const key = sql`coalesce(${changes.groupId}, ${changes.id})`;
    const folded = ctx.db
      .select({
        ...getTableColumns(changes),
        groupSize: sql<number>`count(*) over (partition by ${key})`.as('group_size'),
        groupUndone: sql<number>`count(${changes.revertedAt}) over (partition by ${key})`.as(
          'group_undone',
        ),
        rank: sql<number>`row_number() over (partition by ${key} order by ${changes.at} desc)`.as(
          'rank',
        ),
      })
      .from(changes)
      .where(where)
      .as('folded');
    const rows = await ctx.db
      .select({
        ...folded._.selectedFields,
        // The whole group, beyond this filter: changes.revertGroup undoes all of it.
        groupTotal: sql<number>`(select count(*) from changes g where g.group_id = folded.group_id)`,
      })
      .from(folded)
      .where(eq(folded.rank, 1))
      .orderBy(desc(folded.at))
      .limit(limit);
    return toChanges(
      ctx,
      rows.map(({ rank: _, ...r }) => {
        const groupSize = Number(r.groupSize);
        const groupUndone = Number(r.groupUndone);
        const groupTotal = Math.max(Number(r.groupTotal), groupSize);
        // A folded row reads as undone only once every change in it is.
        const revertedAt = groupUndone < groupSize ? null : r.revertedAt;
        return { ...r, groupSize, groupUndone, groupTotal, revertedAt };
      }),
    );
  },
});

defineOp({
  name: 'changes.revert',
  description:
    'Undo one change. Only the most recent change to an item can be undone; undo newer ones first (a newer change that was already undone does not count). Bulk calls (transcript_renameSpeaker, transcript_replace, transcript_updateSegments, events_createMany …) write one change per item: undo the whole call with changes_revertGroup(groupId) instead.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { changeId }) {
    const [c] = await ctx.db.select().from(changes).where(eq(changes.id, changeId));
    if (!c) throw notFound('Change');
    await requireRevertAccess(ctx, c);
    if (c.revertedAt) throw conflict('This change was already undone.');
    const [latest] = await ctx.db
      .select({ id: changes.id })
      .from(changes)
      .where(
        and(
          eq(changes.entity, c.entity),
          eq(changes.entityId, c.entityId),
          isNull(changes.revertedAt),
          // Compare in SQL: `c.at` as a JS Date has lost its microseconds.
          not(cancelsNewer(sql`(select at from changes where id = ${c.id})`)),
        ),
      )
      .orderBy(desc(changes.at))
      .limit(1);
    if (latest?.id !== c.id)
      throw conflict('This item changed again since; undo the newer change first.');
    if ((c.entity === 'session' || c.entity === 'event') && c.groupId) {
      // A clock change and the events it retimed only make sense undone together.
      const [partner] = await ctx.db
        .select({ id: changes.id })
        .from(changes)
        .where(
          and(
            eq(changes.groupId, c.groupId),
            ne(changes.id, c.id),
            isNull(changes.revertedAt),
            c.entity === 'event' ? eq(changes.entity, 'session') : undefined,
          ),
        )
        .limit(1);
      if (partner)
        throw conflict(
          c.entity === 'session'
            ? 'This clock change also retimed the session’s events; undo the whole call with changes_revertGroup.'
            : 'This event was retimed by a session clock change; undo the whole call with changes_revertGroup.',
        );
    }

    const revertId = await undoChange(ctx, c);
    const [out] = await toChanges(
      ctx,
      await ctx.db.select().from(changes).where(eq(changes.id, revertId)),
    );
    return out!;
  },
});

defineOp({
  name: 'changes.revertGroup',
  description:
    'Undo every change one op call made, in one step — e.g. a transcript_renameSpeaker, transcript_replace or transcript_updateSegments call that touched hundreds of segments. groupId comes from changes_list (every change has one; grouped: true lists one row per call). All or nothing: if any item in the group was changed again later by another call, nothing is undone and it fails with conflict (undo the newer change first; later changes already undone do not count). Changes in the group that were already undone one by one are skipped. The undo is recorded as a new group (the returned groupId); reverting that group redoes the call. It undoes every change in the group, in every session it touched, and needs write access to each of those sessions (or the show); without it, it fails with not_found and nothing is undone. Returns how many changes were undone.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { groupId }) {
    const entries = await ctx.db
      .select()
      .from(changes)
      .where(eq(changes.groupId, groupId))
      .orderBy(desc(changes.at));
    if (entries.length === 0) throw notFound('Change group');
    // A group comes from one op call, so this is usually a single session or show.
    const scopes = new Map<string, ChangeRow>();
    for (const c of entries) scopes.set(c.sessionId ?? `${c.showId}:${c.entity === 'category'}`, c);
    for (const c of scopes.values()) await requireRevertAccess(ctx, c);
    const pending = entries.filter((c) => !c.revertedAt);
    if (pending.length === 0) throw conflict('This group was already undone.');

    // No item may have changed since: no live change outside the group is newer than the
    // group's own change to the same item (a later change undone again cancels out).
    const own = alias(changes, 'own');
    const [newer] = await ctx.db
      .select({ summary: changes.summary })
      .from(changes)
      .innerJoin(
        own,
        and(
          eq(own.groupId, groupId),
          isNull(own.revertedAt),
          eq(own.entity, changes.entity),
          eq(own.entityId, changes.entityId),
          gt(changes.at, own.at),
        ),
      )
      .where(
        and(
          isNull(changes.revertedAt),
          or(isNull(changes.groupId), ne(changes.groupId, groupId)),
          not(cancelsNewer(own.at)),
        ),
      )
      .limit(1);
    if (newer)
      throw conflict(
        `An item in this group changed again since (“${newer.summary}”); undo the newer change first.`,
      );

    // A clock change with its retimed events: restore the clock, then the events in bulk.
    const clock = pending.find((c) => c.entity === 'session');
    const retimed = clock ? pending.filter((c) => c.entity === 'event' && c.kind === 'update') : [];
    if (clock) await undoClockChange(ctx, clock);
    if (retimed.length) await undoRetimedEvents(ctx, retimed);
    const done = new Set([clock, ...retimed]);
    // Newest first, so an item changed twice in the call ends up at its first `before`.
    for (const c of pending) if (!done.has(c)) await undoChange(ctx, c);
    return { groupId: ctx.groupId, reverted: pending.length };
  },
});

async function requireRevertAccess(ctx: Ctx, c: ChangeRow): Promise<void> {
  if (c.sessionId) await requireSession(ctx, c.sessionId, 'write');
  else await requireShow(ctx, c.showId, c.entity === 'category' ? 'manage' : 'write');
}

/** Restore the item to `c.before`, mark `c` undone and record the undo; returns its change id. */
async function undoChange(ctx: Ctx, c: ChangeRow): Promise<string> {
  if (c.entity === 'session') return undoClockChange(ctx, c);
  const { table, live, softDelete, reindex } = TABLES[c.entity];
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
  if (restored && reindex) await reindex(ctx.db, restored);
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
  return revertId;
}

/**
 * Undo a session clock change (sessions.update frameRate / start timecode): restore the clock
 * fields only. Elapsed frames come back exactly unless the transport ran since (then they are
 * rescaled to keep their seconds). Retimed events are their own changes in the same group.
 * Events logged or retimed after the change by another call would move, so that is a conflict.
 */
async function undoClockChange(ctx: Ctx, c: ChangeRow): Promise<string> {
  const { sessions, events } = schema;
  // FOR UPDATE: event writes hold the session FOR SHARE, so none is in flight on this clock.
  const [current] = await ctx.db
    .select()
    .from(sessions)
    .where(eq(sessions.id, c.entityId))
    .for('update');
  if (!current) throw conflict('That session no longer exists.');
  if (current.isRolling) throw conflict('Stop the transport before undoing a clock change.');
  // Any later change to a timed event of this session from another call (create, edit, undo).
  const later = alias(changes, 'later');
  const [moved] = await ctx.db
    .select({ id: later.id })
    .from(later)
    .innerJoin(events, eq(events.id, later.entityId))
    .where(
      and(
        eq(later.entity, 'event'),
        eq(later.sessionId, current.id),
        isNotNull(events.timecodeFrames),
        gt(later.at, sql`(select at from changes where id = ${c.id})`),
        or(
          isNull(later.groupId),
          and(ne(later.groupId, c.groupId ?? ''), ne(later.groupId, ctx.groupId)),
        ),
      ),
    )
    .limit(1);
  if (moved)
    throw conflict(
      'Events were logged or moved after this clock change and would shift; set the frame rate and start timecode back with sessions_update instead.',
    );
  const before = c.before as Clock;
  const after = c.after as Clock;
  const target = clockOf({
    ...before,
    elapsedFrames:
      current.elapsedFrames === after.elapsedFrames
        ? before.elapsedFrames
        : rescaleElapsed(current.elapsedFrames, current.frameRate, before.frameRate),
  });
  await ctx.db
    .update(sessions)
    .set({ ...target, updatedAt: new Date() })
    .where(eq(sessions.id, current.id));
  await ctx.db.update(changes).set({ revertedAt: new Date() }).where(eq(changes.id, c.id));
  const revertId = await ctx.record({
    entity: 'session',
    entityId: current.id,
    kind: 'update',
    summary: `Undid: ${c.summary}`,
    showId: c.showId,
    sessionId: current.id,
    before: clockOf(current),
    after: target,
    revertOf: c.id,
  });
  // Event atSec values depend on the clock.
  ctx.publish(`session:${current.id}`, { type: 'invalidate', entity: 'event' });
  await publishSession(ctx, current.id);
  return revertId;
}

/**
 * Undo the event retimes of a clock change in one statement: only timecodeFrames and updatedAt
 * differ between their before and after snapshots, and revertGroup already checked that none
 * changed since. Each undo is recorded like undoChange does.
 */
async function undoRetimedEvents(ctx: Ctx, list: ChangeRow[]): Promise<void> {
  const { events } = schema;
  const ids = list.map((c) => c.id);
  const current = await ctx.db
    .select()
    .from(events)
    .where(
      inArray(
        events.id,
        list.map((c) => c.entityId),
      ),
    )
    .for('update');
  if (current.length !== new Set(list.map((c) => c.entityId)).size)
    throw conflict('That item no longer exists.');
  const restored = await ctx.db
    .update(events)
    .set({
      timecodeFrames: sql`(${changes.before}->>'timecodeFrames')::bigint`,
      updatedAt: sql`(${changes.before}->>'updatedAt')::timestamptz`,
    })
    .from(changes)
    .where(and(inArray(changes.id, ids), eq(changes.entityId, events.id)))
    .returning(getTableColumns(events));
  await ctx.db.update(changes).set({ revertedAt: new Date() }).where(inArray(changes.id, ids));
  const now = new Map(current.map((r) => [r.id, r]));
  const back = new Map(restored.map((r) => [r.id, r]));
  await ctx.recordMany(
    list.map((c) => ({
      entity: 'event' as const,
      entityId: c.entityId,
      kind: 'update' as const,
      summary: `Undid: ${c.summary}`,
      showId: c.showId,
      sessionId: c.sessionId,
      before: snapshot(now.get(c.entityId)),
      after: snapshot(back.get(c.entityId)),
      revertOf: c.id,
    })),
  );
  for (const sessionId of new Set(list.map((c) => c.sessionId)))
    if (sessionId) ctx.publish(`session:${sessionId}`, { type: 'invalidate', entity: 'event' });
}
