// Transcript replacement rules: find/replace pairs a show applies to every new transcription
// (and transcript.replace applies to an existing session). Rules run inside PostgreSQL
// (regexp_replace, with a statement timeout), so regex rules use PostgreSQL's regular
// expression dialect — the same one transcript.find uses. The server checks each regex there;
// this schema only bounds sizes.

import { z } from 'zod';

export interface TranscriptRule {
  /** Text to find; a PostgreSQL regular expression (ARE) when `regex` is true. */
  find: string;
  /** Replacement. With `regex`, `\1`…`\9` insert capture groups and `\&` the whole match. */
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

export const TranscriptRuleInput = z.object({
  find: z.string().min(1).max(MAX_RULE_FIND_LENGTH),
  replace: z.string().max(MAX_RULE_REPLACE_LENGTH),
  regex: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
});
