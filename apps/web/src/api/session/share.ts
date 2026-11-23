// Structural sharing for session lists. TanStack's default compares arrays by index: once a row is
// inserted or removed mid-list, every later row compares against its neighbour and comes back as a
// new copy, so every memoized row after it re-renders. Matching by id keeps each unchanged row's
// object, whatever its position.

import { replaceEqualDeep } from '@tanstack/react-query';

type MaybeRow = { id?: unknown } | null | undefined;

/** `structuralSharing` for lists of rows with an `id`; anything else is shared the default way. */
export function shareRowsById(prev: unknown, next: unknown): unknown {
  if (!Array.isArray(prev) || !Array.isArray(next)) return replaceEqualDeep(prev, next);
  const byId = new Map<unknown, unknown>();
  for (const row of prev as MaybeRow[]) if (row?.id !== undefined) byId.set(row.id, row);
  let same = prev.length === next.length;
  const out = (next as MaybeRow[]).map((row, i) => {
    const old = row?.id === undefined ? prev[i] : byId.get(row.id);
    const kept = old === undefined ? row : replaceEqualDeep(old, row);
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? prev : out;
}
