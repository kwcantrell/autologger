import type { DashboardQuery, DashboardRows } from '@autologger/contract';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { requireSession } from '../core/authz.ts';
import { changeMessage } from '../core/bus.ts';
import { notFound } from '../core/errors.ts';
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
      return rows
        .filter((r) => !q.categories || q.categories.includes(r.category))
        .slice(0, q.limit);
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
  description: `Create a dashboard (omit dashboardId) or replace one. The spec is declarative JSON:
{ title, description?, widgets: [{ id, type, title, span (1-4 of a 4-column grid), ... }] }.
Widget types: stat {value|data+field, unit?, caption?}; bar {x, y, horizontal?}; line {x, y}; pie {label, value};
table {columns?: [{key,label}]}; timeline {at (seconds field), label, duration?}; markdown {markdown}.
Data widgets take either static \`data\` rows you computed, or a live \`query\` re-evaluated on every view:
events_by_category → {category,color,count}; events_over_time {bucketSec} → {atSec,category,count};
speaker_talk_time → {speaker,seconds,turns}; topics {maxLevel?} → {atSec,durationSec,label,level,summary} (maxLevel 1 = chapters only, best for a timeline);
events {categories?,limit} → {atSec,label,category,message,value,color}; summary_stats → {events,topics,speakers,words,audioSec,speechSec,wpm}
(speechSec = last transcript segment end − first segment start, 0 without a transcript; wpm = words per minute
over speechSec, rounded, null when speechSec is 0 — use it for speaking pace).
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
      [row] = (await ctx.db
        .update(dashboards)
        .set({
          title: spec.title,
          spec,
          revision: prev.row.revision + 1,
          updatedBy: ctx.actor.user.id,
          updatedAt: new Date(),
        })
        .where(eq(dashboards.id, dashboardId))
        .returning()) as [typeof row];
      await ctx.record({
        entity: 'dashboard',
        entityId: row.id,
        kind: 'update',
        summary: `Updated dashboard “${spec.title}”`,
        showId: session.showId,
        sessionId,
        before: snapshot(prev.row),
        after: snapshot(row),
      });
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
