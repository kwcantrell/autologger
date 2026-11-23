import { secondsToClock, type Topic } from '@autologger/contract';
import { asc, eq } from 'drizzle-orm';
import { requireSession } from '../core/authz.ts';
import { changeMessage } from '../core/bus.ts';
import { notFound } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp, snapshot } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { toTopic, userRefs } from './map.ts';

const { topics } = schema;
type TopicRow = typeof topics.$inferSelect;

async function entities(ctx: Ctx, rows: TopicRow[]): Promise<Topic[]> {
  const users = await userRefs(
    ctx.db,
    rows.map((r) => r.createdBy),
  );
  return rows.map((r) => toTopic(r, users));
}

async function loadTopic(ctx: Ctx, topicId: string) {
  const [row] = await ctx.db.select().from(topics).where(eq(topics.id, topicId));
  if (!row) throw notFound('Topic');
  const { session } = await requireSession(ctx, row.sessionId, 'write');
  return { row, session };
}

type TopicFields = {
  startSec: number;
  durationSec: number;
  level: number;
  title: string;
  summary: string;
};

async function insertTopic(
  ctx: Ctx,
  sessionId: string,
  showId: string,
  t: TopicFields,
): Promise<TopicRow> {
  const [row] = await ctx.db
    .insert(topics)
    .values({ id: newId('top'), sessionId, ...t, via: ctx.actor.via, createdBy: ctx.actor.user.id })
    .returning();
  await ctx.record({
    entity: 'topic',
    entityId: row!.id,
    kind: 'create',
    summary: `Added topic “${t.title}” at ${secondsToClock(t.startSec)}`,
    showId,
    sessionId,
    after: snapshot(row),
  });
  return row!;
}

defineOp({
  name: 'topics.list',
  description:
    'Topics (chapters) of a session in time order. Level 1 = major segment, 2–3 = sub-topics. startSec / durationSec are seconds from the session start (as in transcript_text). Agents get `[{ id, startSec, durationSec, level, title, summary }]` per topic by default (compact); pass `compact: false` for full topics.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, compact }) {
    await requireSession(ctx, sessionId, 'read');
    const rows = await ctx.db
      .select()
      .from(topics)
      .where(eq(topics.sessionId, sessionId))
      .orderBy(asc(topics.startSec), asc(topics.level));
    if (compact)
      return rows.map(({ id, startSec, durationSec, level, title, summary }) => ({
        id,
        startSec,
        durationSec,
        level,
        title,
        summary,
      }));
    return entities(ctx, rows);
  },
});

defineOp({
  name: 'topics.create',
  description:
    'Add one topic. startSec/durationSec are seconds from session start (as shown in transcript.text).',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, ...t }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    const [out] = await entities(ctx, [await insertTopic(ctx, sessionId, session.showId, t)]);
    ctx.publish(`session:${sessionId}`, changeMessage('topic', 'upsert', out!.id, out));
    return out!;
  },
});

defineOp({
  name: 'topics.replace',
  description:
    'Replace every topic in the session with this list — the usual way to (re)generate topics from the transcript. Each removed and added topic is in the change log, so the operator can undo it. Returns the new topics sorted by startSec; agents get only `[{ id, startSec, level, title }]` per topic by default (compact); pass `compact: false` for full topics.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, topics: list, compact }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    const old = await ctx.db.select().from(topics).where(eq(topics.sessionId, sessionId));
    await ctx.db.delete(topics).where(eq(topics.sessionId, sessionId));
    for (const row of old) {
      await ctx.record({
        entity: 'topic',
        entityId: row.id,
        kind: 'delete',
        summary: `Removed topic “${row.title}”`,
        showId: session.showId,
        sessionId,
        before: snapshot(row),
      });
    }
    const rows: TopicRow[] = [];
    for (const t of [...list].sort((a, b) => a.startSec - b.startSec))
      rows.push(await insertTopic(ctx, sessionId, session.showId, t));
    ctx.publish(`session:${sessionId}`, { type: 'invalidate', entity: 'topic' });
    if (compact)
      return rows.map(({ id, startSec, level, title }) => ({ id, startSec, level, title }));
    return entities(ctx, rows);
  },
});

defineOp({
  name: 'topics.update',
  description: 'Edit a topic’s title, summary, level or time range.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { topicId, ...patch }) {
    const { row, session } = await loadTopic(ctx, topicId);
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const [after] = await ctx.db
      .update(topics)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(topics.id, topicId))
      .returning();
    await ctx.record({
      entity: 'topic',
      entityId: topicId,
      kind: 'update',
      summary: `Edited topic “${after!.title}”`,
      showId: session.showId,
      sessionId: session.id,
      before: snapshot(row),
      after: snapshot(after),
    });
    const [out] = await entities(ctx, [after!]);
    ctx.publish(`session:${session.id}`, changeMessage('topic', 'upsert', topicId, out));
    return out!;
  },
});

defineOp({
  name: 'topics.delete',
  description: 'Delete a topic.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { topicId }) {
    const { row, session } = await loadTopic(ctx, topicId);
    await ctx.db.delete(topics).where(eq(topics.id, topicId));
    await ctx.record({
      entity: 'topic',
      entityId: topicId,
      kind: 'delete',
      summary: `Deleted topic “${row.title}”`,
      showId: session.showId,
      sessionId: session.id,
      before: snapshot(row),
    });
    ctx.publish(`session:${session.id}`, changeMessage('topic', 'delete', topicId));
    return { deleted: true };
  },
});
