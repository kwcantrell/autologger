import {
  secondsToClock,
  TRANSCRIPT_REPLACE_LIST_LIMIT,
  type TranscriptLine,
  type TranscriptReplaceChange,
} from '@autologger/contract';
import { and, asc, eq, gte, ilike, inArray, lte, sql } from 'drizzle-orm';
import { requireSession } from '../core/authz.ts';
import { changeMessage } from '../core/bus.ts';
import { badRequest, notFound } from '../core/errors.ts';
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
