import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { shareRowsById } from './share';

const row = (id: string, n = 0) => ({ id, n });

describe('shareRowsById', () => {
  it('keeps every unchanged row when one is inserted mid-list', () => {
    const prev = [row('a'), row('c'), row('d')];
    const next = shareRowsById(prev, [row('a'), row('b'), row('c'), row('d')]) as typeof prev;
    expect(next.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(next[0]).toBe(prev[0]);
    expect(next[2]).toBe(prev[1]);
    expect(next[3]).toBe(prev[2]);
  });

  it('returns the previous list when nothing changed, and new rows for changed ones', () => {
    const prev = [row('a'), row('b')];
    expect(shareRowsById(prev, [row('a'), row('b')])).toBe(prev);
    const next = shareRowsById(prev, [row('a'), row('b', 1)]) as typeof prev;
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).toEqual(row('b', 1));
  });

  it('applies to cache writes of a query that uses it', () => {
    const qc = new QueryClient();
    const key = ['rows'];
    qc.getQueryCache().build(qc, { queryKey: key, structuralSharing: shareRowsById });
    const prev = [row('a'), row('c')];
    qc.setQueryData(key, prev);
    qc.setQueryData(key, [row('a'), row('b'), row('c')]);
    expect(qc.getQueryData<typeof prev>(key)?.[2]).toBe(prev[1]);
  });
});
