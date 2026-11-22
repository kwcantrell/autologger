import { secondsToClock } from '@autologger/contract';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { requireSession } from '../core/authz.ts';
import { changeMessage } from '../core/bus.ts';
import { notFound } from '../core/errors.ts';
import { defineOp, snapshot } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { toTranscriptSegment } from './map.ts';

const { transcriptSegments: ts } = schema;

function rangeWhere(sessionId: string, fromSec?: number, toSec?: number) {
  return and(
    eq(ts.sessionId, sessionId),
    fromSec !== undefined ? gte(ts.endSec, fromSec) : undefined,
    toSec !== undefined ? lte(ts.startSec, toSec) : undefined,
  );
}

defineOp({
  name: 'transcript.get',
  description: 'Transcript segments (speaker turns) with word timings. Times are seconds from session start. Prefer transcript.text for reading.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, fromSec, toSec }) {
    await requireSession(ctx, sessionId, 'read');
    const rows = await ctx.db.select().from(ts).where(rangeWhere(sessionId, fromSec, toSec)).orderBy(asc(ts.startSec));
    return rows.map(toTranscriptSegment);
  },
});

defineOp({
  name: 'transcript.text',
  description:
    'The transcript as compact text, one speaker turn per line: `[HH:MM:SS @123.4s] Speaker: text`. The `@seconds` value is what atSec / startSec fields in events.create and topics.create expect. Use fromSec/toSec to page through long sessions.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, fromSec, toSec }) {
    await requireSession(ctx, sessionId, 'read');
    const rows = await ctx.db
      .select({ startSec: ts.startSec, speaker: ts.speaker, text: ts.text })
      .from(ts)
      .where(rangeWhere(sessionId, fromSec, toSec))
      .orderBy(asc(ts.startSec));
    const text = rows
      .map((r) => `[${secondsToClock(r.startSec)} @${r.startSec.toFixed(1)}s] ${r.speaker || 'Speaker'}: ${r.text}`)
      .join('\n');
    return { text, segments: rows.length };
  },
});

defineOp({
  name: 'transcript.updateSegment',
  description: 'Correct the text or speaker of one transcript segment.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { segmentId, text, speaker }) {
    const [row] = await ctx.db.select().from(ts).where(eq(ts.id, segmentId));
    if (!row) throw notFound('Transcript segment');
    const { session } = await requireSession(ctx, row.sessionId, 'write');
    const set: Partial<typeof ts.$inferInsert> = { updatedAt: new Date(), edited: true };
    if (speaker !== undefined) set.speaker = speaker;
    if (text !== undefined && text !== row.text) {
      set.text = text;
      // Word timings no longer match edited text; spread them evenly over the segment.
      const words = text.split(/\s+/).filter(Boolean);
      const step = (row.endSec - row.startSec) / Math.max(1, words.length);
      set.words = words.map((w, i) => ({ w, s: row.startSec + i * step, e: row.startSec + (i + 1) * step }));
    }
    const [after] = await ctx.db.update(ts).set(set).where(eq(ts.id, segmentId)).returning();
    await ctx.record({
      entity: 'transcript_segment',
      entityId: segmentId,
      kind: 'update',
      summary: `Edited transcript at ${secondsToClock(row.startSec)}`,
      showId: session.showId,
      sessionId: session.id,
      before: snapshot(row),
      after: snapshot(after),
    });
    const out = toTranscriptSegment(after!);
    ctx.publish(`session:${session.id}`, changeMessage('transcript_segment', 'upsert', out.id, out));
    return out;
  },
});

defineOp({
  name: 'transcript.renameSpeaker',
  description: 'Rename a speaker label across the whole session transcript (e.g. "Speaker 1" → "Dana").',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, from, to }) {
    await requireSession(ctx, sessionId, 'write');
    const rows = await ctx.db
      .update(ts)
      .set({ speaker: to, updatedAt: new Date() })
      .where(and(eq(ts.sessionId, sessionId), eq(ts.speaker, from)))
      .returning({ id: ts.id });
    ctx.publish(`session:${sessionId}`, { type: 'invalidate', entity: 'transcript_segment' });
    return { updated: rows.length };
  },
});
