import { secondsToClock, type TranscriptFindLine, type TranscriptLine } from '@autologger/contract';
import { and, asc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { requireSession } from '../core/authz.ts';
import { changeMessage } from '../core/bus.ts';
import { badRequest, notFound } from '../core/errors.ts';
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

function findCondition(pattern: string, regex: boolean) {
  return regex
    ? sql`${ts.text} ~* ${pattern}`
    : ilike(ts.text, `%${pattern.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}

/** The substrings of a segment's text that `pattern` matches, in order, as a jsonb array. */
function findMatches(pattern: string, regex: boolean) {
  // `***=` makes the rest of the pattern a literal, so plain text shares the regex functions.
  const p = regex ? pattern : `***=${pattern}`;
  return sql`to_jsonb(array(select regexp_substr(${ts.text}, ${p}, 1, n, 'i') from generate_series(1, regexp_count(${ts.text}, ${p}, 1, 'i')) as n))`;
}

/** Segments within `context` positions (session time order) of the given ones, excluding them. */
async function findContext(ctx: Ctx, sessionId: string, ids: string[], context: number) {
  if (context === 0 || ids.length === 0) return [];
  const near = await ctx.db.execute<{ id: string }>(sql`
    with o as (
      select ${ts.id} as id, row_number() over (order by ${ts.startSec}, ${ts.id}) as rn
      from ${ts} where ${ts.sessionId} = ${sessionId}
    )
    select distinct o.id from o join o hit
      on hit.id in (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )}) and abs(o.rn - hit.rn) <= ${context}`);
  const hit = new Set(ids);
  const want = near.map((r) => r.id).filter((i) => !hit.has(i));
  if (want.length === 0) return [];
  return ctx.db.select().from(ts).where(inArray(ts.id, want));
}

defineOp({
  name: 'transcript.find',
  description:
    'Find transcript segments (speaker turns) in one session whose text matches `pattern`, or any of `patterns` (up to 20, OR-ed; pass exactly one of the two), case-insensitive. By default patterns are plain text (substring match); set `regex: true` to use PostgreSQL regular expressions (POSIX style, e.g. `\\mdoctor\\M` for whole words, `x ?2`). Beware: `\\m`/`\\M` treat apostrophes as word boundaries, so `\\mm\\M` also matches "I\'m". Optional fromSec/toSec (seconds from session start) narrow the range. Regex searches time out after 2 seconds (bad_request). ' +
    'Returns `{ id, startSec, endSec, speaker, text, edited, matches, patternIndexes }` per matching line in time order, without word timings: `matches` lists the distinct matched substrings as written in the text, `patternIndexes` the 0-based indexes into `patterns` that matched (always `[0]` with `pattern`). At most `limit` matching lines (default 500); page with fromSec if you hit the limit. ' +
    'Optional `context` (0-3, default 0) also returns up to that many neighbouring lines before and after each match (from the whole session, ignoring fromSec/toSec), flagged `context: true` and without matches or patternIndexes; use it when an error may span two segments. Pass the ids to transcript.updateSegments to fix them.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, input) {
    const { sessionId, regex, fromSec, toSec, limit, context } = input;
    const patterns = input.patterns ?? [input.pattern ?? ''];
    await requireSession(ctx, sessionId, 'read');
    try {
      // Bound regex cost: this op's transaction is read-only, so a local timeout is safe.
      if (regex) await ctx.db.execute(sql`set local statement_timeout = '2s'`);
      const rows = await ctx.db
        .select({
          row: ts,
          hits: sql<string[][]>`jsonb_build_array(${sql.join(
            patterns.map((p) => findMatches(p, regex)),
            sql`, `,
          )})`,
        })
        .from(ts)
        .where(
          and(
            rangeWhere(sessionId, fromSec, toSec),
            or(...patterns.map((p) => findCondition(p, regex))),
          ),
        )
        .orderBy(asc(ts.startSec), asc(ts.id))
        .limit(limit);
      const lines: TranscriptFindLine[] = rows.map(({ row, hits }) => ({
        ...toTranscriptLine(row),
        matches: [...new Set(hits.flat())],
        patternIndexes: hits.flatMap((h, i) => (h.length > 0 ? [i] : [])),
      }));
      const around = await findContext(
        ctx,
        sessionId,
        lines.map((l) => l.id),
        context,
      );
      if (around.length === 0) return lines;
      return [
        ...lines,
        ...around.map((r): TranscriptFindLine => ({ ...toTranscriptLine(r), context: true })),
      ].sort((a, b) => a.startSec - b.startSec || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } catch (e) {
      const err = e as { code?: string; cause?: { code?: string; message?: string } };
      const code = err.code ?? err.cause?.code;
      // 2201B invalid_regular_expression
      if (code === '2201B') {
        throw badRequest(
          `Invalid regular expression: ${err.cause?.message ?? patterns.join(' | ')}`,
        );
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
