import { describe, expect, it } from 'vitest';
import { alignWordTimings } from './words.ts';

const old = [
  { w: 'Ask', s: 10, e: 10.4 },
  { w: 'the', s: 10.4, e: 10.6 },
  { w: 'doctor', s: 10.7, e: 11.2 },
  { w: 'about', s: 11.3, e: 11.6 },
  { w: 'it.', s: 11.6, e: 12 },
];

describe('alignWordTimings', () => {
  it('replacing one word keeps every timing, the new word taking the old slot', () => {
    expect(alignWordTimings(old, 'Ask the dr about it.', 10, 12)).toEqual([
      { w: 'Ask', s: 10, e: 10.4 },
      { w: 'the', s: 10.4, e: 10.6 },
      { w: 'dr', s: 10.7, e: 11.2 },
      { w: 'about', s: 11.3, e: 11.6 },
      { w: 'it.', s: 11.6, e: 12 },
    ]);
  });

  it('a multi-word replacement shares the time of the words it replaced', () => {
    expect(alignWordTimings(old, 'Ask the family physician about it.', 10, 12)).toEqual([
      old[0],
      old[1],
      { w: 'family', s: 10.7, e: 10.95 },
      { w: 'physician', s: 10.95, e: 11.2 },
      old[3],
      old[4],
    ]);
  });

  it('inserts between neighbours, at the start and at the end', () => {
    const out = alignWordTimings(old, 'So Ask the doctor right about it. Please', 9, 13);
    expect(out).toEqual([
      { w: 'So', s: 9, e: 10 },
      old[0],
      old[1],
      old[2],
      { w: 'right', s: 11.2, e: 11.3 },
      old[3],
      old[4],
      { w: 'Please', s: 12, e: 13 },
    ]);
  });

  it('deleting words leaves the remaining timings untouched', () => {
    expect(alignWordTimings(old, 'Ask the doctor.', 10, 12)).toEqual([
      old[0],
      old[1],
      { w: 'doctor.', s: 10.7, e: 12 },
    ]);
    expect(alignWordTimings(old, 'the doctor about it.', 10, 12)).toEqual(old.slice(1));
  });

  it('falls back to even spacing when nothing aligns or there were no timings', () => {
    const even = [
      { w: 'Totally', s: 10, e: 11 },
      { w: 'different', s: 11, e: 12 },
    ];
    expect(alignWordTimings(old, 'Totally different', 10, 12)).toEqual(even);
    expect(alignWordTimings([], 'Totally different', 10, 12)).toEqual(even);
    expect(alignWordTimings(old, '   ', 10, 12)).toEqual([]);
  });
});
