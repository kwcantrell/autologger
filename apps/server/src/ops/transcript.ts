import {
  secondsToClock,
  TRANSCRIPT_REPLACE_LIST_LIMIT,
  type TranscriptFindLine,
  type TranscriptLine,
  type TranscriptReplaceChange,
} from '@autologger/contract';
import { and, asc, eq, gt, gte, ilike, inArray, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { requireSession } from '../core/authz.ts';
import { changeMessage } from '../core/bus.ts';
import { badRequest, notFound } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp, snapshot } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { checkRules, ruleCounts, runRules } from '../media/rules.ts';
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
  /** false: the caller publishes one `invalidate` for its whole batch instead. */
  publish = true,
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
  if (publish) {
    const out = toTranscriptSegment(after!);
    ctx.publish(
      `session:${session.id}`,
      changeMessage('transcript_segment', 'upsert', out.id, out),
    );
  }
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

/** The non-empty substrings of a segment's text that `pattern` matches, in order (text[]). */
function matchArray(pattern: string, regex: boolean) {
  // `***=` makes the rest of the pattern a literal, so plain text shares the regex functions.
  const p = regex ? pattern : `***=${pattern}`;
  // Patterns like `x*` also match the empty string everywhere; those hits are dropped.
  return sql`array(select m from (select regexp_substr(${ts.text}, ${p}, 1, n, 'i') as m from generate_series(1, regexp_count(${ts.text}, ${p}, 1, 'i')) as n) as hits where m <> '')`;
}

function findCondition(pattern: string, regex: boolean) {
  return regex
    ? sql`(${ts.text} ~* ${pattern} and cardinality(${matchArray(pattern, regex)}) > 0)`
    : ilike(ts.text, `%${pattern.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}

function findMatches(pattern: string, regex: boolean) {
  return sql`to_jsonb(${matchArray(pattern, regex)})`;
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
    'Correct the text and/or speaker of up to 500 transcript segments of one session in a single call (ids from transcript.find or transcript.get). All edits apply in one transaction: if any segmentId is unknown or belongs to another session, nothing changes. Each changed segment is its own entry in the change log, so the operator can undo edits one by one from the Agents tab; entries that change nothing are skipped. Unchanged words keep their recorded word timings; only inserted or replaced words get interpolated ones. Returns `{ updated, segments }` with `{ id, startSec, endSec, speaker, text, edited }` lines (no word timings), in the order given. Pass `compact: true` to get only `{ updated, ids }` (the segment ids actually changed, in the order given), which saves context on large batches.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, updates, compact }) {
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

    const changed: string[] = [];
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
      changed.push(row.id);
    }
    if (compact) return { updated: changed.length, ids: changed };
    return { updated: changed.length, segments };
  },
});

defineOp({
  name: 'transcript.renameSpeaker',
  description:
    'Rename a speaker label in a session transcript (e.g. "Speaker 1" → "Dana"): every segment labelled `from` gets the label `to`. ' +
    'Optional fromSec/toSec (seconds from session start, as in transcript_text `@seconds`) limit it to segments that START in [fromSec, toSec), e.g. `{ fromSec: 0, toSec: 47, to: "Promo" }` for an intro. With a range, `from` may be omitted to relabel every segment in it whatever its speaker; without a range `from` is required and the whole session is renamed. ' +
    'A segment that starts inside the range but runs past it is renamed whole: split it first with transcript.splitSegment (atSec or atText). ' +
    'Each renamed segment is its own change-log entry, undoable from the Agents tab. Returns `{ updated }`, the number of segments renamed.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, from, to, fromSec, toSec }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    const where = and(
      eq(ts.sessionId, sessionId),
      from !== undefined ? eq(ts.speaker, from) : undefined,
      fromSec !== undefined ? gte(ts.startSec, fromSec) : undefined,
      toSec !== undefined ? lt(ts.startSec, toSec) : undefined,
      sql`${ts.speaker} <> ${to}`,
    );
    const before = await ctx.db.select().from(ts).where(where).orderBy(asc(ts.startSec));
    if (before.length === 0) return { updated: 0 };
    const rows = await ctx.db
      .update(ts)
      .set({ speaker: to, updatedAt: new Date() })
      .where(
        inArray(
          ts.id,
          before.map((r) => r.id),
        ),
      )
      .returning();
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of before) {
      await ctx.record({
        entity: 'transcript_segment',
        entityId: r.id,
        kind: 'update',
        summary: `Renamed speaker "${r.speaker}" to "${to}" at ${secondsToClock(r.startSec)}`,
        showId: session.showId,
        sessionId,
        before: snapshot(r),
        after: snapshot(byId.get(r.id)),
      });
    }
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

/** Lower-case a word and drop punctuation, so "Okay." matches "okay". */
const normWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Word index where `phrase` starts (split before it); it must occur exactly once, not at the start. */
function splitIndexOfText(words: SegmentRow['words'], phrase: string): number {
  const want = phrase.split(/\s+/).map(normWord).filter(Boolean);
  if (want.length === 0) throw badRequest('atText has no words to look for.');
  const have = words.map((w) => normWord(w.w));
  const hits: number[] = [];
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((t, k) => have[i + k] === t)) hits.push(i);
  }
  if (hits.length === 0)
    throw badRequest(
      `atText "${phrase}" is not in this segment (matched word by word, ignoring case and punctuation).`,
    );
  if (hits.length > 1)
    throw badRequest(
      `atText "${phrase}" occurs ${hits.length} times in this segment; give more words or use atSec.`,
    );
  if (hits[0] === 0)
    throw badRequest(
      `atText "${phrase}" starts the segment; there is nothing to split off before it.`,
    );
  return hits[0]!;
}

/** Index of the first word starting at or after `atSec`; it must leave words on both sides. */
function splitIndexOfSec(words: SegmentRow['words'], atSec: number): number {
  const i = words.findIndex((w) => w.s >= atSec);
  if (i < 1)
    throw badRequest(
      `atSec ${atSec} must fall after the first word (${words[0]?.s ?? '?'}s) and at or before the last word's start (${words.at(-1)?.s ?? '?'}s) of this segment.`,
    );
  return i;
}

defineOp({
  name: 'transcript.mergeSegments',
  description:
    'Merge 2 to 50 transcript segments (ids from transcript.find or transcript.get) into one, e.g. to rejoin a phrase split mid-sentence or two overlapping segments that read in the wrong order. The segments must belong to the same session and audio recording and be adjacent in time order (no other segment starts between them) or overlap. The merged segment keeps the id of the earliest-starting segment and spans the earliest start to the latest end (seconds from session start); its words are all words sorted by start time and its text is rebuilt from those words, so make text fixes after merging. Because words are interleaved by start time, merging overlapping segments from different speakers mixes their words into one line: do not merge overlaps from different speakers. Speaker comes from the earliest segment unless `speaker` is given. The other segments are deleted. Change log: one entry per row (an update for the kept segment and a delete per removed segment), not one entry for the merge; to undo the merge, revert all of them together (Agents tab or changes.revert, any order) to restore the originals exactly. Reverting only some leaves duplicate or missing lines. Returns the merged segment with word timings.',
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
    "Split one transcript segment (segmentId from transcript.find or transcript.get) in two. Say where with exactly one of: `atText`, a phrase from the segment's text to split before (e.g. the first words of the second speaker's reply; matched word by word ignoring case and punctuation; it must occur exactly once and not at the very start, else bad_request: add words or use atSec); `atSec`, seconds from session start (split before the first word starting at or after it, e.g. a time read from transcript_text `@seconds`); or `atWord`, a 0-based index into the segment's `words` from transcript.get, at least 1 and less than the word count. The original keeps its id and the words before `atWord`; a new segment gets that word and the rest. The split time is that word's start (seconds from session start). Both texts are rebuilt from their words. The new segment keeps the speaker unless `speaker` is given (use it when the speaker changes mid-segment). Change log: one entry per row (an update for the original and a create for the new segment), not one entry for the split; to undo the split, revert both together (any order) to restore the original exactly. Reverting only one leaves duplicate or missing words. Returns both segments in time order, with word timings.",
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { segmentId, atWord: givenWord, atText, atSec, speaker }) {
    const [row] = await ctx.db.select().from(ts).where(eq(ts.id, segmentId));
    if (!row) throw notFound('Transcript segment');
    const { session } = await requireSession(ctx, row.sessionId, 'write');
    const words = timedWords(row);
    const atWord =
      atText !== undefined
        ? splitIndexOfText(words, atText)
        : atSec !== undefined
          ? splitIndexOfSec(words, atSec)
          : givenWord!;
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

// ── transcript.replace: find/replace rules over an existing transcript (#24) ──

/** transcript.replace refuses calls with more segments × rules than this. */
const MAX_REPLACE_WORK = 200_000;
/** Total time all rules of one transcript.replace call may take in PostgreSQL. */
const REPLACE_BUDGET_MS = 5000;

defineOp({
  name: 'transcript.replace',
  description:
    'Apply find/replace rules to the existing transcript of one session, e.g. `rules: [{ find: "doctor", replace: "dr", wholeWord: true }]`. ' +
    'Rule fields are those of the show setting `transcriptRules` (see shows_update): `find` is plain text unless `regex: true`, then a PostgreSQL regular expression, the same dialect as transcript_find (`\\m`/`\\M` word boundaries; `\\1`…`\\9` in `replace` insert capture groups); `wholeWord` only matches whole words; matching is case-insensitive unless `caseSensitive: true`; rules run in order on each segment. ' +
    "Omit `rules` to apply the show's saved transcriptRules (e.g. to a session transcribed before they were set, without re-transcribing and losing manual edits). Optional fromSec/toSec (seconds from session start) limit it to segments overlapping that range. " +
    'Set `dryRun: true` first to preview: nothing is written and the result lists the would-be changes. Otherwise all changes apply in one transaction; each changed segment is its own change-log entry, undoable one by one from the Agents tab, and unchanged words keep their word timings. Segments a rule would empty are left unchanged. ' +
    'Limits (bad_request): invalid regexes or ones matching empty text; segments × rules over 200000 (narrow fromSec/toSec); a rule running over 2 s or all rules over 5 s. Segments over 20000 characters are skipped. ' +
    'Returns `{ dryRun, changed, rules: [{ find, replace, count }], segments: [{ id, startSec, endSec, speaker, before, after }], truncated }`; `segments` lists at most 500 changes in time order (truncated is then true; narrow fromSec/toSec to see the rest).',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, rules: given, fromSec, toSec, dryRun }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    let rules = given;
    if (!rules) {
      const [show] = await ctx.db
        .select({ rules: schema.shows.transcriptRules })
        .from(schema.shows)
        .where(eq(schema.shows.id, session.showId));
      rules = show?.rules ?? [];
      if (!rules.length)
        throw badRequest(
          'This show has no transcript rules. Pass `rules`, or save them on the show with shows_update.',
        );
    }
    await checkRules(ctx.db, rules);
    const rows = await ctx.db
      .select()
      .from(ts)
      .where(rangeWhere(sessionId, fromSec, toSec))
      .orderBy(asc(ts.startSec));
    if (rows.length * rules.length > MAX_REPLACE_WORK)
      throw badRequest(
        `${rows.length} segments × ${rules.length} rules is too much for one call (limit ${MAX_REPLACE_WORK}); narrow fromSec/toSec or pass fewer rules.`,
      );
    const run = await runRules(
      ctx.db,
      rows.map((r) => r.text),
      rules,
      { budgetMs: REPLACE_BUDGET_MS, onError: 'throw' },
    );

    const changes: TranscriptReplaceChange[] = [];
    for (const [i, row] of rows.entries()) {
      const text = run.texts[i]!;
      if (text === row.text) continue;
      const after = text.trim();
      // A rule that empties a segment leaves it alone (the transcribe job drops such segments).
      if (!after || after === row.text) continue;
      if (!dryRun) await editSegment(ctx, session, row, { text: after }, false);
      changes.push({
        id: row.id,
        startSec: row.startSec,
        endSec: row.endSec,
        speaker: row.speaker,
        before: row.text,
        after,
      });
    }
    if (!dryRun && changes.length)
      ctx.publish(`session:${sessionId}`, { type: 'invalidate', entity: 'transcript_segment' });
    return {
      dryRun,
      changed: changes.length,
      rules: ruleCounts(rules, run.counts),
      segments: changes.slice(0, TRANSCRIPT_REPLACE_LIST_LIMIT),
      truncated: changes.length > TRANSCRIPT_REPLACE_LIST_LIMIT,
    };
  },
});
