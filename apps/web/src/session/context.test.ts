// The playhead's coarse selectors rest on indexAt: last start at or before a second.

import { describe, expect, it } from 'vitest';
import { indexAt } from './context';

describe('indexAt', () => {
  it('finds the last start at or before the second', () => {
    const starts = [0, 5, 5, 12.5, 30];
    expect(indexAt(starts, -1)).toBe(-1);
    expect(indexAt(starts, 0)).toBe(0);
    expect(indexAt(starts, 5)).toBe(2);
    expect(indexAt(starts, 12.49)).toBe(2);
    expect(indexAt(starts, 12.5)).toBe(3);
    expect(indexAt(starts, 999)).toBe(4);
    expect(indexAt([], 3)).toBe(-1);
  });
});
