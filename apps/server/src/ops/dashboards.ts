import {
  type DashboardQuery,
  type DashboardRows,
  type DashboardSpec,
  Widget,
} from '@autologger/contract';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { requireSession } from '../core/authz.ts';
import { changeMessage } from '../core/bus.ts';
import { AppError, badRequest, notFound } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp, snapshot } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { toDashboard, userRefs } from './map.ts';

const { dashboards, events, topics, transcriptSegments, sessions } = schema;

async function entity(ctx: Ctx, row: typeof dashboards.$inferSelect) {
  return toDashboard(row, await userRefs(ctx.db, [row.createdBy, row.updatedBy]));
}

async function loadDashboard(ctx: Ctx, id: string, need: 'read' | 'write') {
  const [row] = await ctx.db.select().from(dashboards).where(eq(dashboards.id, id));
  if (!row) throw notFound('Dashboard');
  const { session } = await requireSession(ctx, row.sessionId, need);
  return { row, session };
}

/** JSON with object keys sorted, to compare widgets regardless of key order. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
}

/** Replace a stored dashboard's spec as a new revision, recorded for undo. */
async function updateSpec(
  ctx: Ctx,
  prev: typeof dashboards.$inferSelect,
  session: { id: string; showId: string },
  spec: DashboardSpec,
) {
  const [row] = (await ctx.db
    .update(dashboards)
    .set({
      title: spec.title,
      spec,
      revision: prev.revision + 1,
      updatedBy: ctx.actor.user.id,
      updatedAt: new Date(),
    })
    .where(eq(dashboards.id, prev.id))
    .returning()) as [typeof dashboards.$inferSelect];
  await ctx.record({
    entity: 'dashboard',
    entityId: row.id,
    kind: 'update',
    summary: `Updated dashboard “${spec.title}”`,
    showId: session.showId,
    sessionId: session.id,
    before: snapshot(prev),
    after: snapshot(row),
  });
  return row;
}

/** Evaluate a named live query over one session. Rows use stable, documented field names. */
export async function runDashboardQuery(
  ctx: Ctx,
  sessionId: string,
  q: DashboardQuery,
): Promise<DashboardRows> {
  const [s] = await ctx.db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!s) throw notFound('Session');
  const atSec = sql<number>`greatest(0, (${events.timecodeFrames} - ${s.startOffsetFrames})::float / ${s.frameRate})`;
  switch (q.name) {
    case 'events_by_category':
      return ctx.db
        .select({
          category: events.category,
          color: sql<string>`max(${events.color})`,
          count: sql<number>`count(*)::int`,
        })
        .from(events)
        .where(eq(events.sessionId, sessionId))
        .groupBy(events.category)
        .orderBy(desc(sql`count(*)`));
    case 'events_over_time': {
      const rows = await ctx.db
        .select({
          bucket: sql<number>`floor(${atSec} / ${q.bucketSec})::int`,
          category: events.category,
          count: sql<number>`count(*)::int`,
        })
        .from(events)
        .where(eq(events.sessionId, sessionId))
        .groupBy(sql`1`, events.category)
        .orderBy(sql`1`);
      return rows
        .filter((r) => !q.categories || q.categories.includes(r.category))
        .map((r) => ({ atSec: r.bucket * q.bucketSec, category: r.category, count: r.count }));
    }
    case 'speaker_talk_time':
      return ctx.db
        .select({
          speaker: transcriptSegments.speaker,
          seconds: sql<number>`round(sum(${transcriptSegments.endSec} - ${transcriptSegments.startSec})::numeric, 1)::float`,
          turns: sql<number>`count(*)::int`,
        })
        .from(transcriptSegments)
        .where(eq(transcriptSegments.sessionId, sessionId))
        .groupBy(transcriptSegments.speaker)
        .orderBy(desc(sql`2`));
    case 'topics':
      return ctx.db
        .select({
          atSec: topics.startSec,
          durationSec: topics.durationSec,
          label: topics.title,
          level: topics.level,
          summary: topics.summary,
        })
        .from(topics)
        .where(
          and(
            eq(topics.sessionId, sessionId),
            q.maxLevel ? lte(topics.level, q.maxLevel) : undefined,
          ),
        )
        .orderBy(asc(topics.startSec));
    case 'events': {
      const rows = await ctx.db
        .select({
          atSec,
          label: events.category,
          category: events.category,
          message: events.message,
          value: events.value,
          color: events.color,
        })
        .from(events)
        .where(eq(events.sessionId, sessionId))
        .orderBy(asc(events.timecodeFrames))
        .limit(2000);
      // Rounded to ms like events_list, so both report the same atSec for an event.
      return rows
        .filter((r) => !q.categories || q.categories.includes(r.category))
        .slice(0, q.limit)
        .map((r) => ({ ...r, atSec: Math.round(r.atSec * 1000) / 1000 }));
    }
    case 'summary_stats': {
      const [r] = await ctx.db
        .select({
          events: sql<number>`(select count(*)::int from events where session_id = ${sessionId})`,
          topics: sql<number>`(select count(*)::int from topics where session_id = ${sessionId})`,
          speakers: sql<number>`(select count(distinct speaker)::int from transcript_segments where session_id = ${sessionId})`,
          words: sql<number>`(select coalesce(sum(jsonb_array_length(words)),0)::int from transcript_segments where session_id = ${sessionId})`,
          audioSec: sql<number>`(select coalesce(sum(duration_sec),0)::float from audio_segments where session_id = ${sessionId})`,
          speechSec: sql<number>`(select coalesce(max(end_sec) - min(start_sec),0)::float from transcript_segments where session_id = ${sessionId})`,
        })
        .from(sql`(select 1) as one`);
      // Speaking pace over the transcript span (first segment start → last segment end).
      const speechSec = Math.max(0, r!.speechSec);
      return [
        {
          ...r!,
          speechSec: Math.round(speechSec * 10) / 10,
          wpm: speechSec > 0 ? Math.round(r!.words / (speechSec / 60)) : null,
        },
      ];
    }
    case 'category_count': {
      // Always one row, so a stat shows 0 rather than nothing when the category has no events.
      const [r] = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(events)
        .where(and(eq(events.sessionId, sessionId), inArray(events.category, q.categories)));
      return [{ count: r?.count ?? 0 }];
    }
  }
}

defineOp({
  name: 'dashboards.list',
  description: 'Dashboards saved on a session.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId }) {
    await requireSession(ctx, sessionId, 'read');
    const rows = await ctx.db
      .select()
      .from(dashboards)
      .where(eq(dashboards.sessionId, sessionId))
      .orderBy(asc(dashboards.createdAt));
    const users = await userRefs(
      ctx.db,
      rows.flatMap((r) => [r.createdBy, r.updatedBy]),
    );
    return rows.map((r) => toDashboard(r, users));
  },
});

defineOp({
  name: 'dashboards.get',
  description: 'One dashboard with its full spec.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { dashboardId }) {
    const { row } = await loadDashboard(ctx, dashboardId, 'read');
    return entity(ctx, row);
  },
});

defineOp({
  name: 'dashboards.save',
  description: `Create a dashboard (omit dashboardId) or replace one (to change a few widgets, use dashboards_updateWidgets). The spec is declarative JSON:
{ title, description?, widgets: [{ id, type, title, span (1-4 of a 4-column grid), ... }] }.
Widget types: stat {value|data+field, unit?, caption?}; bar {x, y, horizontal?}; line {x, y}; pie {label, value};
table {columns?: [{key,label?,format?}]} (without columns, an atSec column shows as a duration); timeline {at (seconds field), label, duration?}; markdown {markdown}.
Unknown fields are rejected with bad_request naming their path (e.g. spec.widgets[4].foo), never silently dropped.
Data widgets take either static \`data\` rows you computed, or a live \`query\` re-evaluated on every view:
events_by_category → {category,color,count}; events_over_time {bucketSec} → {atSec,category,count};
speaker_talk_time → {speaker,seconds,turns}; topics {maxLevel?} → {atSec,durationSec,label,level,summary} (maxLevel 1 = chapters only, best for a timeline);
events {categories?,limit} → {atSec (rounded to ms, as in events_list),label,category,message,value,color}; summary_stats → {events,topics,speakers,words,audioSec,speechSec,wpm}
(speechSec = last transcript segment end − first segment start, 0 without a transcript; wpm = words per minute
over speechSec, rounded, null when speechSec is 0 — use it for speaking pace);
category_count {categories: [button names]} → one row {count} = events in those categories, 0 when none — the live
count of one category on a stat, e.g. { type: "stat", query: { name: "category_count", categories: ["Key insight"] } }.
Optional format on stat, bar/line and pie values and on table columns: duration (s → M:SS/H:MM:SS) | minutes (s → min, 1 decimal) | number | percent (0–1 ratio); bar labelMaxChars truncates labels (full text in tooltip).
Empty state on any data widget: emptyText (≤200 chars, e.g. "No speech in this session") replaces the widget's content when
its query returns no rows (a stat: its value is null, e.g. wpm without a transcript); hideWhenEmpty: true hides the widget instead.
Use them when one layout is applied to many sessions, some without speech, topics or events.
Prefer live queries for counts so the dashboard stays current. Markdown is rendered without HTML.
Returns the saved dashboard including its spec; pass compact: true to get only { id, revision } (revision starts at 1 and
increases on every save), which saves context.`,
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, dashboardId, spec, compact }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    let row: typeof dashboards.$inferSelect;
    if (dashboardId) {
      const prev = await loadDashboard(ctx, dashboardId, 'write');
      row = await updateSpec(ctx, prev.row, session, spec);
    } else {
      [row] = (await ctx.db
        .insert(dashboards)
        .values({
          id: newId('dsh'),
          sessionId,
          title: spec.title,
          spec,
          via: ctx.actor.via,
          createdBy: ctx.actor.user.id,
          updatedBy: ctx.actor.user.id,
        })
        .returning()) as [typeof row];
      await ctx.record({
        entity: 'dashboard',
        entityId: row.id,
        kind: 'create',
        summary: `Created dashboard “${spec.title}”`,
        showId: session.showId,
        sessionId,
        after: snapshot(row),
      });
    }
    const out = await entity(ctx, row);
    ctx.publish(`session:${sessionId}`, changeMessage('dashboard', 'upsert', out.id, out));
    return compact ? { id: out.id, revision: out.revision } : out;
  },
});

defineOp({
  name: 'dashboards.updateWidgets',
  description: `Change some widgets of a saved dashboard without resending the whole spec. widgets is a list of
patches: { id (an existing widget id, from dashboards_get), ...fields to set }. Fields you give replace the
stored ones (a query or data replaces the whole query/data), fields you omit stay, and null removes an optional
field (e.g. labelMaxChars: null). Example: { dashboardId, widgets: [{ id: "talk", title: "Talk time", format: "minutes" }] }.
Each patched widget is validated like dashboards_save (bad_request with the path, e.g. widgets[3].x); an unknown widget
id fails with nothing changed. type cannot be patched; changing type, order, adding and removing widgets need
dashboards_save. Saved as one new revision, undoable from the change log; a patch that changes nothing saves nothing. Returns the dashboard; compact: true returns only { id, revision }.`,
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { dashboardId, widgets: patches, compact }) {
    const { row: prev, session } = await loadDashboard(ctx, dashboardId, 'write');
    const stored = prev.spec as DashboardSpec;
    const byId = new Map(patches.map((p) => [p.id, p]));
    if (byId.size !== patches.length) throw badRequest('Each widget id may appear only once.');
    if (patches.some((p) => 'type' in p))
      throw badRequest(
        'A widget patch cannot change type; replace the widget with dashboards_save.',
      );
    const known = new Set(stored.widgets.map((w) => w.id));
    const unknown = [...byId.keys()].filter((id) => !known.has(id));
    if (unknown.length)
      throw badRequest(
        `No widget with id ${unknown.join(', ')} on this dashboard (ids: ${[...known].join(', ')}).`,
      );
    // Only patched widgets are validated; untouched ones stay exactly as stored, so an older
    // widget the schema no longer accepts never blocks a patch to another one.
    const issues: { path: string; message: string }[] = [];
    let changed = false;
    const widgets = stored.widgets.map((w, i) => {
      const patch = byId.get(w.id);
      if (!patch) return w;
      const merged: Record<string, unknown> = { ...w };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      const r = Widget.safeParse(merged);
      if (!r.success) {
        for (const issue of r.error.issues)
          issues.push({
            path: [`widgets[${i}]`, ...issue.path.map(String)].join('.'),
            message: issue.message,
          });
        return w;
      }
      if (stableJson(r.data) !== stableJson(w)) changed = true;
      return r.data;
    });
    if (issues.length) throw new AppError('bad_request', 'Invalid widget patch.', issues);
    if (!changed) {
      const out = await entity(ctx, prev);
      return compact ? { id: out.id, revision: out.revision } : out;
    }
    const spec = { ...stored, widgets };
    const row = await updateSpec(ctx, prev, session, spec);
    const out = await entity(ctx, row);
    ctx.publish(`session:${session.id}`, changeMessage('dashboard', 'upsert', out.id, out));
    return compact ? { id: out.id, revision: out.revision } : out;
  },
});

defineOp({
  name: 'dashboards.delete',
  description: 'Delete a dashboard.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { dashboardId }) {
    const { row, session } = await loadDashboard(ctx, dashboardId, 'write');
    await ctx.db.delete(dashboards).where(eq(dashboards.id, dashboardId));
    await ctx.record({
      entity: 'dashboard',
      entityId: row.id,
      kind: 'delete',
      summary: `Deleted dashboard “${row.title}”`,
      showId: session.showId,
      sessionId: session.id,
      before: snapshot(row),
    });
    ctx.publish(`session:${session.id}`, changeMessage('dashboard', 'delete', dashboardId));
    return { deleted: true };
  },
});

defineOp({
  name: 'dashboards.query',
  description:
    'Run one live dashboard query and return its rows (useful to preview data before saving a dashboard).',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, query }) {
    await requireSession(ctx, sessionId, 'read');
    return runDashboardQuery(ctx, sessionId, query);
  },
});
