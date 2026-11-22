import { secondsToClock, type TranscriptLine } from '@autologger/contract';
import { and, asc, eq, gt, gte, ilike, inArray, lt, lte, notInArray, sql } from 'drizzle-orm';
import { requireSession } from '../core/authz.ts';
import { changeMessage } from '../core/bus.ts';
import { badRequest, notFound } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp, snapshot } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { alignWordTimings } from '../media/words.ts';
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
  description:
    'Transcript segments (speaker turns) with word timings. Times are seconds from session start. Prefer transcript.text for reading.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, fromSec, toSec }) {
    await requireSession(ctx, sessionId, 'read');
    const rows = await ctx.db
      .select()
      .from(ts)
      .where(rangeWhere(sessionId, fromSec, toSec))
      .orderBy(asc(ts.startSec));
    return rows.map(toTranscriptSegment);
  },
});

defineOp({
  name: 'transcript.text',
  description:
    'The transcript as compact text, one speaker turn per line: `[HH:MM:SS @123.4s] Speaker: text`. The `@seconds` value is what atSec / startSec fields in events.create and topics.create expect. Use fromSec/toSec to page through long sessions. Lines carry no segment ids; use transcript.find to get ids of lines to correct.',
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
      .map(
        (r) =>
          `[${secondsToClock(r.startSec)} @${r.startSec.toFixed(1)}s] ${r.speaker || 'Speaker'}: ${r.text}`,
      )
      .join('\n');
    return { text, segments: rows.length };
  },
});

type SegmentRow = typeof ts.$inferSelect;
type SessionRow = Awaited<ReturnType<typeof requireSession>>['session'];

function toTranscriptLine(r: SegmentRow): TranscriptLine {
  return {
    id: r.id,
    startSec: r.startSec,
    endSec: r.endSec,
    speaker: r.speaker,
    text: r.text,
    edited: r.edited,
  };
}

/** Word timings for a segment whose text was edited. */
function wordsForEditedText(row: SegmentRow, text: string): SegmentRow['words'] {
  // Keep real timings for unchanged words; only inserted or replaced words get interpolated ones.
  return alignWordTimings(row.words, text, row.startSec, row.endSec);
}

/**
 * Apply one text/speaker correction to a loaded segment: update the row, record the change
 * (undoable per segment) and publish it. Shared by transcript.updateSegment and
 * transcript.updateSegments. The caller has already authorized write access to `session`.
 */
async function editSegment(
  ctx: Ctx,
  session: SessionRow,
  row: SegmentRow,
  edit: { text?: string; speaker?: string },
): Promise<SegmentRow> {
  const set: Partial<typeof ts.$inferInsert> = { updatedAt: new Date(), edited: true };
  if (edit.speaker !== undefined) set.speaker = edit.speaker;
  if (edit.text !== undefined && edit.text !== row.text) {
    set.text = edit.text;
    set.words = wordsForEditedText(row, edit.text);
  }
  const [after] = await ctx.db.update(ts).set(set).where(eq(ts.id, row.id)).returning();
  await ctx.record({
    entity: 'transcript_segment',
    entityId: row.id,
    kind: 'update',
    summary: `Edited transcript at ${secondsToClock(row.startSec)}`,
    showId: session.showId,
    sessionId: session.id,
    before: snapshot(row),
    after: snapshot(after),
  });
  const out = toTranscriptSegment(after!);
  ctx.publish(`session:${session.id}`, changeMessage('transcript_segment', 'upsert', out.id, out));
  return after!;
}

defineOp({
  name: 'transcript.updateSegment',
  description:
    'Correct the text or speaker of one transcript segment (segmentId from transcript.find or transcript.get). ' +
    'Unchanged words keep their recorded word timings; only inserted or replaced words get ' +
    'interpolated timings, so prefer small targeted edits over rewriting a whole segment. ' +
    'Returns the segment with word timings. To fix many lines, use transcript.updateSegments instead.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { segmentId, text, speaker }) {
    const [row] = await ctx.db.select().from(ts).where(eq(ts.id, segmentId));
    if (!row) throw notFound('Transcript segment');
    const { session } = await requireSession(ctx, row.sessionId, 'write');
    return toTranscriptSegment(await editSegment(ctx, session, row, { text, speaker }));
  },
});

defineOp({
  name: 'transcript.find',
  description:
    'Find transcript segments (speaker turns) in one session whose text matches `pattern`, case-insensitive. By default `pattern` is plain text (substring match); set `regex: true` to use a PostgreSQL regular expression (POSIX style, e.g. `\\mdoctor\\M` for whole words, `x ?2`). Optional fromSec/toSec (seconds from session start) narrow the range. Regex searches time out after 2 seconds (bad_request). Returns `{ id, startSec, endSec, speaker, text, edited }` per match in time order, without word timings, at most `limit` (default 500); page with fromSec if you hit the limit. Pass the ids to transcript.updateSegments to fix them.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, pattern, regex, fromSec, toSec, limit }) {
    await requireSession(ctx, sessionId, 'read');
    const match = regex
      ? sql`${ts.text} ~* ${pattern}`
      : ilike(ts.text, `%${pattern.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    try {
      // Bound regex cost: this op's transaction is read-only, so a local timeout is safe.
      if (regex) await ctx.db.execute(sql`set local statement_timeout = '2s'`);
      const rows = await ctx.db
        .select()
        .from(ts)
        .where(and(rangeWhere(sessionId, fromSec, toSec), match))
        .orderBy(asc(ts.startSec))
        .limit(limit);
      return rows.map(toTranscriptLine);
    } catch (e) {
      const err = e as { code?: string; cause?: { code?: string; message?: string } };
      const code = err.code ?? err.cause?.code;
      // 2201B invalid_regular_expression
      if (code === '2201B') {
        throw badRequest(`Invalid regular expression: ${err.cause?.message ?? pattern}`);
      }
      // 57014 query_canceled (statement_timeout)
      if (code === '57014') {
        throw badRequest(
          'Pattern too slow: simplify the regular expression or narrow fromSec/toSec.',
        );
      }
      throw e;
    }
  },
});

defineOp({
  name: 'transcript.updateSegments',
  description:
    'Correct the text and/or speaker of up to 500 transcript segments of one session in a single call (ids from transcript.find or transcript.get). All edits apply in one transaction: if any segmentId is unknown or belongs to another session, nothing changes. Each changed segment is its own entry in the change log, so the operator can undo edits one by one from the Agents tab; entries that change nothing are skipped. Unchanged words keep their recorded word timings; only inserted or replaced words get interpolated ones. Returns `{ updated, segments }` with compact `{ id, startSec, endSec, speaker, text, edited }` lines (no word timings), in the order given.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, updates }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    const ids = updates.map((u) => u.segmentId);
    if (new Set(ids).size !== ids.length) throw badRequest('Each segmentId may appear only once.');
    const rows = await ctx.db
      .select()
      .from(ts)
      .where(and(eq(ts.sessionId, sessionId), inArray(ts.id, ids)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.filter((i) => !byId.has(i));
    if (missing.length) throw notFound(`Transcript segment ${missing.slice(0, 5).join(', ')}`);

    let updated = 0;
    const segments: TranscriptLine[] = [];
    for (const u of updates) {
      const row = byId.get(u.segmentId)!;
      const changes =
        (u.text !== undefined && u.text !== row.text) ||
        (u.speaker !== undefined && u.speaker !== row.speaker);
      if (!changes) {
        segments.push(toTranscriptLine(row));
        continue;
      }
      segments.push(toTranscriptLine(await editSegment(ctx, session, row, u)));
      updated++;
    }
    return { updated, segments };
  },
});

defineOp({
  name: 'transcript.renameSpeaker',
  description:
    'Rename a speaker label across the whole session transcript (e.g. "Speaker 1" → "Dana").',
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

// ── Segment structure: merge and split ───────────────────────────────────────
// Each row change is its own change-log entry (update / create / delete of a
// transcript_segment). They touch different rows, so undoing all entries of one merge or split,
// in any order, restores the original segments exactly (same ids, text, words and timestamps).

/** Word timings for a segment, spreading its text evenly when it has none recorded. */
function timedWords(row: SegmentRow): SegmentRow['words'] {
  return row.words.length ? row.words : alignWordTimings([], row.text, row.startSec, row.endSec);
}

const wordsText = (words: SegmentRow['words']) => words.map((w) => w.w).join(' ');

defineOp({
  name: 'transcript.mergeSegments',
  description:
    'Merge 2 to 50 transcript segments (ids from transcript.find or transcript.get) into one, e.g. to rejoin a phrase split mid-sentence or two overlapping segments that read in the wrong order. The segments must belong to the same session and audio recording and be adjacent in time order (no other segment starts between them) or overlap. The merged segment keeps the id of the earliest-starting segment and spans the earliest start to the latest end (seconds from session start); its words are all words sorted by start time and its text is rebuilt from those words, so make text fixes after merging. Speaker comes from the earliest segment unless `speaker` is given. The other segments are deleted. Change log: one update entry for the kept segment and one delete entry per removed segment; undo all of them (Agents tab or changes.revert, any order) to restore the originals exactly. Returns the merged segment with word timings.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { segmentIds, speaker }) {
    if (new Set(segmentIds).size !== segmentIds.length)
      throw badRequest('Each segmentId may appear only once.');
    const rows = await ctx.db.select().from(ts).where(inArray(ts.id, segmentIds));
    const sessionId = rows[0]?.sessionId;
    if (
      rows.length !== segmentIds.length ||
      !sessionId ||
      rows.some((r) => r.sessionId !== sessionId)
    )
      throw notFound('Transcript segment');
    const { session } = await requireSession(ctx, sessionId, 'write');
    if (new Set(rows.map((r) => r.audioSegmentId ?? '')).size > 1)
      throw badRequest('Segments come from different audio recordings and cannot be merged.');

    const sorted = [...rows].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
    const first = sorted[0]!;
    // Adjacent or overlapping: no unselected segment may start inside a gap between them.
    let reach = first.endSec;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const next = sorted[i]!;
      if (next.startSec > reach) {
        const [between] = await ctx.db
          .select({ id: ts.id })
          .from(ts)
          .where(
            and(
              eq(ts.sessionId, sessionId),
              gt(ts.startSec, prev.startSec),
              lt(ts.startSec, next.startSec),
              notInArray(ts.id, segmentIds),
            ),
          )
          .limit(1);
        if (between)
          throw badRequest(
            `Segments are not adjacent: segment ${between.id} lies between ${secondsToClock(prev.startSec)} and ${secondsToClock(next.startSec)}.`,
          );
      }
      reach = Math.max(reach, next.endSec);
    }

    const words = sorted.flatMap(timedWords).sort((a, b) => a.s - b.s);
    const [after] = await ctx.db
      .update(ts)
      .set({
        startSec: first.startSec,
        endSec: Math.max(...sorted.map((r) => r.endSec)),
        speaker: speaker ?? first.speaker,
        text: wordsText(words),
        words,
        edited: true,
        updatedAt: new Date(),
      })
      .where(eq(ts.id, first.id))
      .returning();
    const summary = `Merged ${sorted.length} transcript segments at ${secondsToClock(first.startSec)}`;
    await ctx.record({
      entity: 'transcript_segment',
      entityId: first.id,
      kind: 'update',
      summary,
      showId: session.showId,
      sessionId,
      before: snapshot(first),
      after: snapshot(after),
    });
    const removed = sorted.slice(1);
    await ctx.db.delete(ts).where(
      inArray(
        ts.id,
        removed.map((r) => r.id),
      ),
    );
    for (const r of removed) {
      await ctx.record({
        entity: 'transcript_segment',
        entityId: r.id,
        kind: 'delete',
        summary: `${summary} (removed the one at ${secondsToClock(r.startSec)})`,
        showId: session.showId,
        sessionId,
        before: snapshot(r),
        after: null,
      });
    }
    ctx.publish(`session:${sessionId}`, { type: 'invalidate', entity: 'transcript_segment' });
    return toTranscriptSegment(after!);
  },
});

defineOp({
  name: 'transcript.splitSegment',
  description:
    "Split one transcript segment (segmentId from transcript.find or transcript.get) in two at word index `atWord`: a 0-based index into the segment's `words` from transcript.get, at least 1 and less than the word count. The original keeps its id and the words before `atWord`; a new segment gets that word and the rest. The split time is that word's start (seconds from session start). Both texts are rebuilt from their words. The new segment keeps the speaker unless `speaker` is given (use it when the speaker changes mid-segment). Change log: an update entry for the original and a create entry for the new segment; undo both (any order) to restore the original exactly. Returns both segments in time order, with word timings.",
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { segmentId, atWord, speaker }) {
    const [row] = await ctx.db.select().from(ts).where(eq(ts.id, segmentId));
    if (!row) throw notFound('Transcript segment');
    const { session } = await requireSession(ctx, row.sessionId, 'write');
    const words = timedWords(row);
    if (atWord >= words.length)
      throw badRequest(
        `atWord must be between 1 and ${words.length - 1} for this segment (it has ${words.length} words).`,
      );
    const head = words.slice(0, atWord);
    const tail = words.slice(atWord);
    const splitSec = Math.min(Math.max(tail[0]!.s, row.startSec), row.endSec);
    const now = new Date();

    const [first] = await ctx.db
      .update(ts)
      .set({ endSec: splitSec, text: wordsText(head), words: head, edited: true, updatedAt: now })
      .where(eq(ts.id, row.id))
      .returning();
    const [second] = await ctx.db
      .insert(ts)
      .values({
        id: newId('seg'),
        sessionId: row.sessionId,
        audioSegmentId: row.audioSegmentId,
        startSec: splitSec,
        endSec: row.endSec,
        speaker: speaker ?? row.speaker,
        text: wordsText(tail),
        words: tail,
        edited: true,
      })
      .returning();
    const base = {
      entity: 'transcript_segment' as const,
      summary: `Split transcript segment at ${secondsToClock(splitSec)}`,
      showId: session.showId,
      sessionId: row.sessionId,
    };
    await ctx.record({
      ...base,
      entityId: row.id,
      kind: 'update',
      before: snapshot(row),
      after: snapshot(first),
    });
    await ctx.record({
      ...base,
      entityId: second!.id,
      kind: 'create',
      before: null,
      after: snapshot(second),
    });
    ctx.publish(`session:${row.sessionId}`, { type: 'invalidate', entity: 'transcript_segment' });
    return [toTranscriptSegment(first!), toTranscriptSegment(second!)];
  },
});
