// A tiny LCS line diff (no deps) and its figure. `−` lines are only in `from`, `+` only in `to`.

import { useMemo } from 'react';
import { cn } from '@/shared/lib/utils';

export type DiffKind = 'added' | 'removed' | 'same';
export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** Above this many cells the LCS table is skipped and the whole text shows as replaced. */
const MAX_CELLS = 4_000_000;

export function lineDiff(from: string, to: string): DiffLine[] {
  const a = from === '' ? [] : from.replace(/\n$/, '').split('\n');
  const b = to === '' ? [] : to.replace(/\n$/, '').split('\n');
  // Common prefix / suffix first: most edits touch a few lines.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ kind: 'same', text }));
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  const n = ma.length;
  const m = mb.length;
  const mid: DiffLine[] = [];
  if (n * m > MAX_CELLS) {
    for (const text of ma) mid.push({ kind: 'removed', text });
    for (const text of mb) mid.push({ kind: 'added', text });
    return [...head, ...mid, ...tail];
  }
  // lcs[i][j] = LCS length of ma[i..] and mb[j..], flattened.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] = ma[i] === mb[j] ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ma[i] === mb[j]) {
      mid.push({ kind: 'same', text: ma[i] ?? '' });
      i++;
      j++;
    } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) mid.push({ kind: 'removed', text: ma[i++] ?? '' });
    else mid.push({ kind: 'added', text: mb[j++] ?? '' });
  }
  while (i < n) mid.push({ kind: 'removed', text: ma[i++] ?? '' });
  while (j < m) mid.push({ kind: 'added', text: mb[j++] ?? '' });
  return [...head, ...mid, ...tail];
}

const DIFF_LINE: Record<DiffKind, string> = {
  added: 'bg-(--si-primary-tint) text-si-fg',
  removed: 'bg-(--si-danger-line) text-si-fg',
  same: 'text-si-muted',
};
const DIFF_MARK: Record<DiffKind, string> = { added: '+', removed: '−', same: ' ' };
const DIFF_SR: Record<DiffKind, string> = { added: 'Added: ', removed: 'Removed: ', same: '' };

export function DiffFigure({ from, to, label }: { from: string; to: string; label: string }) {
  const lines = useMemo(() => lineDiff(from, to), [from, to]);
  if (!lines.some((l) => l.kind !== 'same'))
    return <p className="m-0 text-xs text-si-muted">The text is the same as the current page.</p>;
  return (
    <figure
      aria-label={label}
      className="m-0 overflow-x-auto rounded-ctl border border-si-line py-1 font-mono text-[0.78rem] leading-relaxed"
    >
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff line has no identity but its position
          key={i}
          data-diff={l.kind}
          className={cn('pr-2 pl-[1.75rem] -indent-[1.25rem] whitespace-pre-wrap break-words', DIFF_LINE[l.kind])}
        >
          <span aria-hidden="true" className="mr-2 inline-block w-3 indent-0 select-none text-si-dim">
            {DIFF_MARK[l.kind]}
          </span>
          {l.kind !== 'same' && <span className="sr-only">{DIFF_SR[l.kind]}</span>}
          {l.text || ' '}
        </div>
      ))}
    </figure>
  );
}
