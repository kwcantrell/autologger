// Transcript replacement rules: find/replace pairs a show applies to every new transcription
// (and transcript.replace applies to an existing session). Shared so the server and the web
// settings form validate rules the same way.

import { z } from 'zod';

export interface TranscriptRule {
  /** Text to find; a JavaScript regular expression when `regex` is true. */
  find: string;
  /** Replacement. With `regex`, `$1`, `$<name>`, `$&` and `$$` refer to the match. */
  replace: string;
  regex?: boolean;
  /** Only match where `find` is not part of a longer word (letters, digits, `_`). */
  wholeWord?: boolean;
  /** Match case exactly. Default false: case-insensitive, like transcript.find. */
  caseSensitive?: boolean;
}

/** How often one rule matched (in a transcription job, or a transcript.replace call). */
export interface TranscriptRuleCount {
  find: string;
  replace: string;
  count: number;
}

export const MAX_TRANSCRIPT_RULES = 100;
export const MAX_RULE_FIND_LENGTH = 200;
export const MAX_RULE_REPLACE_LENGTH = 200;
/** transcript.replace lists at most this many changed segments in its result. */
export const TRANSCRIPT_REPLACE_LIST_LIMIT = 500;

const escapeRegex = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/** A group that contains a quantifier and is itself quantified, e.g. `(a+)+` or `(\w+\s?)*`. */
const NESTED_QUANTIFIER =
  /\((?:[^()\\]|\\.)*(?:[*+]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[*+]|\{\d+,\d*\})/;

/**
 * Compile a rule to a global, Unicode-aware RegExp. Throws an Error with a readable message
 * when the rule is not usable (invalid or potentially very slow regular expression).
 */
export function compileTranscriptRule(rule: TranscriptRule): RegExp {
  let source = rule.regex ? rule.find : escapeRegex(rule.find);
  if (rule.regex && NESTED_QUANTIFIER.test(rule.find))
    throw new Error(
      `“${rule.find}” nests quantifiers (like (a+)+), which can make matching very slow. Simplify the pattern.`,
    );
  if (rule.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, rule.caseSensitive ? 'gu' : 'giu');
  } catch (e) {
    throw new Error(`“${rule.find}” is not a valid regular expression: ${(e as Error).message}`);
  }
}

/** Why a rule cannot be used, or null if it is fine. */
export function transcriptRuleError(rule: TranscriptRule): string | null {
  try {
    compileTranscriptRule(rule);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export const TranscriptRuleInput = z
  .object({
    find: z.string().min(1).max(MAX_RULE_FIND_LENGTH),
    replace: z.string().max(MAX_RULE_REPLACE_LENGTH),
    regex: z.boolean().optional(),
    wholeWord: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
  })
  .superRefine((rule, ctx) => {
    const error = transcriptRuleError(rule);
    if (error) ctx.addIssue({ code: 'custom', message: error, path: ['find'] });
  });
