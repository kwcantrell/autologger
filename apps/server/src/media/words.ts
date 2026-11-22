// Keep word timings across a transcript text edit.

import type { TranscriptWord } from '@autologger/contract';

/** Above this many old×new word pairs, skip the O(n·m) alignment and spread evenly. */
const MAX_CELLS = 250_000;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Spread `tokens` evenly over [from, to]. */
function spread(tokens: string[], from: number, to: number): TranscriptWord[] {
  const step = Math.max(0, to - from) / Math.max(1, tokens.length);
  return tokens.map((w, i) => ({ w, s: r3(from + i * step), e: r3(from + (i + 1) * step) }));
}

/**
 * Word timings for `newText`, reusing `oldWords` where the text did not change.
 *
 * Aligns old and new word lists (longest common subsequence on exact tokens). Unchanged words
 * keep their original `s`/`e`. Each changed run between unchanged words is timed as follows:
 * a run that replaces the same number of old words takes their timings one-to-one; any other
 * replacement is spread over the time the removed words covered; a pure insertion is spread over
 * the gap between its neighbours (segment bounds at the edges). If nothing aligns (or there were
 * no timings to begin with), all words are spread evenly over [startSec, endSec].
 */
export function alignWordTimings(
  oldWords: readonly TranscriptWord[],
  newText: string,
  startSec: number,
  endSec: number,
): TranscriptWord[] {
  const next = newText.split(/\s+/).filter(Boolean);
  const n = oldWords.length;
  const m = next.length;
  if (m === 0) return [];
  if (n === 0 || n * m > MAX_CELLS) return spread(next, startSec, endSec);

  // lcs[i][j] = LCS length of oldWords[i..] and next[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        oldWords[i]!.w === next[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  if (lcs[0]![0] === 0) return spread(next, startSec, endSec);

  const out: TranscriptWord[] = [];
  let i = 0;
  let j = 0;
  let runI = 0; // start of the current unmatched run in oldWords
  let runJ = 0; // start of the current unmatched run in next

  const flush = () => {
    const removed = oldWords.slice(runI, i);
    const added = next.slice(runJ, j);
    if (added.length > 0) {
      if (removed.length === added.length) {
        out.push(...added.map((w, k) => ({ w, s: removed[k]!.s, e: removed[k]!.e })));
      } else if (removed.length > 0) {
        out.push(...spread(added, removed[0]!.s, removed.at(-1)!.e));
      } else {
        const from = out.at(-1)?.e ?? Math.min(startSec, oldWords[0]!.s);
        const to = i < n ? oldWords[i]!.s : Math.max(endSec, from);
        out.push(...spread(added, from, Math.max(from, to)));
      }
    }
  };

  while (i < n || j < m) {
    if (i < n && j < m && oldWords[i]!.w === next[j]) {
      flush();
      out.push({ w: next[j]!, s: oldWords[i]!.s, e: oldWords[i]!.e });
      i++;
      j++;
      runI = i;
      runJ = j;
    } else if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      i++;
    } else {
      j++;
    }
  }
  flush();
  return out;
}
