// Apply a show's transcript replacement rules to transcript text and segments.

import {
  compileTranscriptRule,
  type TranscriptRule,
  type TranscriptRuleCount,
  type TranscriptWord,
} from '@autologger/contract';
import { alignWordTimings } from './words.ts';

export interface CompiledRule {
  rule: TranscriptRule;
  re: RegExp;
}

/** Compile rules once for many texts. Throws on an invalid rule (the contract rejects those). */
export const compileRules = (rules: readonly TranscriptRule[]): CompiledRule[] =>
  rules.map((rule) => ({ rule, re: compileTranscriptRule(rule) }));

/** Expand `$$`, `$&`, `$1`…`$99` and `$<name>` in a regex rule's replacement. */
function expand(template: string, match: string, groups: (string | undefined)[], named?: object) {
  return template.replace(/\$(\$|&|\d{1,2}|<([^>]*)>)/g, (token, what: string, name?: string) => {
    if (what === '$') return '$';
    if (what === '&') return match;
    if (name !== undefined) {
      if (!named) return token;
      return (named as Record<string, string | undefined>)[name] ?? '';
    }
    // `$12` means group 12 if it exists, otherwise group 1 followed by "2".
    const n = Number(what);
    if (n >= 1 && n <= groups.length) return groups[n - 1] ?? '';
    const first = Number(what[0]);
    if (what.length === 2 && first >= 1 && first <= groups.length)
      return (groups[first - 1] ?? '') + what[1];
    return token;
  });
}

/**
 * Apply rules in order to one text. Each rule sees the output of the rules before it.
 * Literal rules insert `replace` as is; regex rules expand `$1`, `$<name>`, `$&` and `$$`.
 * Empty matches (e.g. from `x*`) are left alone and not counted.
 */
export function applyRulesToText(
  text: string,
  rules: readonly CompiledRule[],
): { text: string; counts: number[] } {
  const counts = rules.map(() => 0);
  let out = text;
  rules.forEach(({ rule, re }, i) => {
    re.lastIndex = 0;
    out = out.replace(re, (match: string, ...rest: unknown[]) => {
      if (match === '') return match;
      counts[i]!++;
      if (!rule.regex) return rule.replace;
      // rest = [...groups, offset, input, namedGroups?]
      const named = typeof rest.at(-1) === 'object' ? (rest.pop() as object) : undefined;
      const groups = rest.slice(0, -2) as (string | undefined)[];
      return expand(rule.replace, match, groups, named);
    });
  });
  return { text: out, counts };
}

export interface RuleSegment {
  startSec: number;
  endSec: number;
  text: string;
  words: TranscriptWord[];
}

/**
 * Apply rules to transcript segments (pure). A changed segment gets the new text and word
 * timings realigned with alignWordTimings: unchanged words keep their timings. Segments the
 * rules empty entirely are dropped. Returns per-rule match counts.
 */
export function applyTranscriptRules<T extends RuleSegment>(
  segments: readonly T[],
  rules: readonly TranscriptRule[],
): { segments: T[]; counts: TranscriptRuleCount[]; changed: number } {
  const compiled = compileRules(rules);
  const totals = rules.map(() => 0);
  let changed = 0;
  const out: T[] = [];
  for (const seg of segments) {
    const { text, counts } = applyRulesToText(seg.text, compiled);
    counts.forEach((c, i) => {
      totals[i]! += c;
    });
    if (text === seg.text) {
      out.push(seg);
      continue;
    }
    changed++;
    const trimmed = text.trim();
    if (!trimmed) continue;
    out.push({
      ...seg,
      text: trimmed,
      words: alignWordTimings(seg.words, trimmed, seg.startSec, seg.endSec),
    });
  }
  return { segments: out, counts: ruleCounts(rules, totals), changed };
}

export const ruleCounts = (
  rules: readonly TranscriptRule[],
  counts: readonly number[],
): TranscriptRuleCount[] =>
  rules.map((r, i) => ({ find: r.find, replace: r.replace, count: counts[i] ?? 0 }));

/** A short note like `3 replacements (doctor → dr ×2, dsdt → ds dt ×1)`, or null for none. */
export function describeRuleCounts(counts: readonly TranscriptRuleCount[]): string | null {
  const hits = counts.filter((c) => c.count > 0);
  const total = hits.reduce((n, c) => n + c.count, 0);
  if (!total) return null;
  const short = (s: string) => (s.length > 24 ? `${s.slice(0, 23)}…` : s);
  const listed = hits
    .slice(0, 10)
    .map((c) => `${short(c.find)} → ${short(c.replace) || '""'} ×${c.count}`)
    .join(', ');
  const more = hits.length > 10 ? `, +${hits.length - 10} more rules` : '';
  return `${total} replacement${total === 1 ? '' : 's'} (${listed}${more})`;
}
