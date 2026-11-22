// Transcript replacement rules. Matching runs inside PostgreSQL (regexp_replace /
// regexp_count) under a statement timeout, never in Node: a user's regular expression cannot
// stall the API or the worker. Word timings are then realigned in JS.

import type { TranscriptRule, TranscriptRuleCount, TranscriptWord } from '@autologger/contract';
import { sql } from 'drizzle-orm';
import { badRequest } from '../core/errors.ts';
import { type DbOrTx, db } from '../db/client.ts';
import { alignWordTimings } from './words.ts';

/** Longest a single rule may run over a batch of segments. */
export const RULE_TIMEOUT_MS = 2000;
/** Segments with more text than this are left as they are. */
export const MAX_RULE_TEXT_CHARS = 20_000;

/** Escape literal text for a PostgreSQL ARE: `\` before any other non-alphanumeric is literal. */
const escapeAre = (s: string) => s.replace(/[^\p{L}\p{N}\s]/gu, '\\$&');

/** The PostgreSQL pattern, replacement and flags a rule runs with. */
export function ruleSql(rule: TranscriptRule): {
  pattern: string;
  replacement: string;
  flags: string;
} {
  let pattern = rule.regex ? rule.find : escapeAre(rule.find);
  // Lookarounds rather than \m…\M so a find that starts or ends with punctuation ("dr.") works.
  if (rule.wholeWord) pattern = `(?<![[:alnum:]_])(?:${pattern})(?![[:alnum:]_])`;
  // In a replacement `\1` and `\&` are special: literal rules escape their backslashes.
  const replacement = rule.regex ? rule.replace : rule.replace.replace(/\\/g, '\\\\');
  return { pattern, replacement, flags: rule.caseSensitive ? '' : 'i' };
}

function pgCode(e: unknown): { code?: string; message?: string } {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  return { code: err.code ?? err.cause?.code, message: err.cause?.message ?? err.message };
}
const INVALID_REGEX = '2201B';
const QUERY_CANCELED = '57014';

const ruleName = (rule: TranscriptRule, i: number) => `Rule ${i + 1} (“${rule.find.slice(0, 40)}”)`;

/**
 * Check regex rules in PostgreSQL: each must compile and must not match empty text.
 * Throws bad_request naming the first bad rule. Runs in the caller's transaction.
 */
export async function checkRules(tx: DbOrTx, rules: readonly TranscriptRule[]): Promise<void> {
  for (const [i, rule] of rules.entries()) {
    if (!rule.regex) continue;
    const { pattern, flags } = ruleSql(rule);
    let empty: boolean;
    try {
      const [row] = await tx.execute<{ m: boolean }>(
        sql`select regexp_like('', ${pattern}, ${flags}) as m`,
      );
      empty = Boolean(row?.m);
    } catch (e) {
      const err = pgCode(e);
      if (err.code === INVALID_REGEX)
        throw badRequest(`${ruleName(rule, i)} is not a valid regular expression: ${err.message}`);
      throw e;
    }
    if (empty)
      throw badRequest(`${ruleName(rule, i)} matches empty text; make it match something.`);
  }
}

export interface RuleRun {
  /** The texts after all rules, in input order. */
  texts: string[];
  /** Matches per rule, in rule order. */
  counts: number[];
  /** Rules skipped (worker only): invalid, or too slow within the time budget. */
  skipped: { index: number; reason: 'invalid' | 'timeout' }[];
}

/**
 * Apply rules in order to `texts` inside PostgreSQL: one query per rule over all texts, each
 * rule seeing the output of the rules before it. Each query gets at most RULE_TIMEOUT_MS and
 * all of them together at most `budgetMs`.
 *
 * `onError: 'throw'` (ops): a too-slow or invalid rule throws bad_request; run it in the op's
 * transaction, which then aborts. `onError: 'skip'` (worker): each rule runs in a savepoint and
 * a failing one is skipped and reported.
 */
export async function runRules(
  tx: DbOrTx,
  texts: readonly string[],
  rules: readonly TranscriptRule[],
  opts: { budgetMs: number; onError: 'throw' | 'skip' },
): Promise<RuleRun> {
  let current = [...texts];
  const counts = rules.map(() => 0);
  const skipped: RuleRun['skipped'] = [];
  if (!current.length) return { texts: current, counts, skipped };
  const deadline = Date.now() + opts.budgetMs;

  for (const [i, rule] of rules.entries()) {
    const left = deadline - Date.now();
    if (left <= 0) {
      if (opts.onError === 'throw')
        throw badRequest(
          `The rules took longer than ${opts.budgetMs / 1000} s in total; use fewer or simpler rules, or narrow fromSec/toSec.`,
        );
      skipped.push({ index: i, reason: 'timeout' });
      continue;
    }
    const timeout = String(Math.max(1, Math.min(RULE_TIMEOUT_MS, left)));
    const { pattern, replacement, flags } = ruleSql(rule);
    const run = async (q: DbOrTx) => {
      await q.execute(sql`select set_config('statement_timeout', ${timeout}, true)`);
      return q.execute<{ out: string; n: number }>(sql`
        select
          case when length(t) > ${MAX_RULE_TEXT_CHARS} then t
               else regexp_replace(t, ${pattern}, ${replacement}, ${`g${flags}`}) end as out,
          case when length(t) > ${MAX_RULE_TEXT_CHARS} then 0
               else regexp_count(t, ${pattern}, 1, ${flags}) end::int as n
        from jsonb_array_elements_text(${JSON.stringify(current)}::jsonb) with ordinality as u(t, ord)
        order by ord`);
    };
    try {
      const rows = opts.onError === 'skip' ? await tx.transaction(run) : await run(tx);
      current = rows.map((r) => r.out);
      counts[i] = rows.reduce((n, r) => n + Number(r.n), 0);
    } catch (e) {
      const { code, message } = pgCode(e);
      if (code !== QUERY_CANCELED && code !== INVALID_REGEX) throw e;
      const reason = code === QUERY_CANCELED ? 'timeout' : 'invalid';
      if (opts.onError === 'skip') {
        skipped.push({ index: i, reason });
        continue;
      }
      throw badRequest(
        reason === 'timeout'
          ? `${ruleName(rule, i)} is too slow (over ${RULE_TIMEOUT_MS / 1000} s); simplify the regular expression or narrow fromSec/toSec.`
          : `${ruleName(rule, i)} is not a valid regular expression: ${message}`,
      );
    }
  }
  if (opts.onError === 'throw') await tx.execute(sql`set local statement_timeout to default`);
  return { texts: current, counts, skipped };
}

export interface RuleSegment {
  startSec: number;
  endSec: number;
  text: string;
  words: TranscriptWord[];
}

/**
 * Give segments their rewritten texts (pure). A changed segment gets the trimmed new text and
 * word timings realigned with alignWordTimings (unchanged words keep their timings); a
 * segment the rules empty entirely is dropped.
 */
export function realignSegments<T extends RuleSegment>(
  segments: readonly T[],
  texts: readonly string[],
): T[] {
  const out: T[] = [];
  segments.forEach((seg, i) => {
    const text = texts[i] ?? seg.text;
    if (text === seg.text) {
      out.push(seg);
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    out.push({
      ...seg,
      text: trimmed,
      words: alignWordTimings(seg.words, trimmed, seg.startSec, seg.endSec),
    });
  });
  return out;
}

/** Total time the transcribe job spends on a show's rules for one audio segment. */
const JOB_RULES_BUDGET_MS = 30_000;

/**
 * The transcribe job's step: apply a show's rules to freshly mapped segments. Never throws for
 * a bad or slow rule; it is skipped and reported instead.
 */
export async function applyShowRules<T extends RuleSegment>(
  segments: readonly T[],
  rules: readonly TranscriptRule[],
): Promise<{ segments: T[]; counts: TranscriptRuleCount[]; skipped: TranscriptRule[] }> {
  if (!rules.length || !segments.length)
    return { segments: [...segments], counts: ruleCounts(rules, []), skipped: [] };
  const run = await db.transaction((tx) =>
    runRules(
      tx,
      segments.map((s) => s.text),
      rules,
      { budgetMs: JOB_RULES_BUDGET_MS, onError: 'skip' },
    ),
  );
  return {
    segments: realignSegments(segments, run.texts),
    counts: ruleCounts(rules, run.counts),
    skipped: run.skipped.map((s) => rules[s.index]!),
  };
}

export const ruleCounts = (
  rules: readonly TranscriptRule[],
  counts: readonly number[],
): TranscriptRuleCount[] =>
  rules.map((r, i) => ({ find: r.find, replace: r.replace, count: counts[i] ?? 0 }));

const short = (s: string) => (s.length > 24 ? `${s.slice(0, 23)}…` : s);

/** A short note like `3 replacements (doctor → dr ×2, dsdt → ds dt ×1)`, or null for none. */
export function describeRuleCounts(
  counts: readonly TranscriptRuleCount[],
  skipped: readonly TranscriptRule[] = [],
): string | null {
  const hits = counts.filter((c) => c.count > 0);
  const total = hits.reduce((n, c) => n + c.count, 0);
  const parts: string[] = [];
  if (total) {
    const listed = hits
      .slice(0, 10)
      .map((c) => `${short(c.find)} → ${short(c.replace) || '""'} ×${c.count}`)
      .join(', ');
    const more = hits.length > 10 ? `, +${hits.length - 10} more rules` : '';
    parts.push(`rules made ${total} replacement${total === 1 ? '' : 's'} (${listed}${more})`);
  }
  if (skipped.length)
    parts.push(
      `skipped ${skipped.length} rule${skipped.length === 1 ? '' : 's'} that failed or took too long (${skipped
        .slice(0, 5)
        .map((r) => short(r.find))
        .join(', ')})`,
    );
  return parts.length ? parts.join('; ') : null;
}
