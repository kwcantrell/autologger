import { describe, expect, it } from 'vitest';
import { describeRuleCounts, realignSegments, ruleSql } from './rules.ts';

describe('transcript rules (pure parts)', () => {
  it('turns rules into PostgreSQL patterns, escaping literal text and replacements', () => {
    expect(ruleSql({ find: 'a.b (x)', replace: 'c\\1' })).toEqual({
      pattern: 'a\\.b \\(x\\)',
      replacement: 'c\\\\1',
      flags: 'i',
    });
    expect(ruleSql({ find: 'd(\\w)', replace: 'd \\1', regex: true, caseSensitive: true })).toEqual(
      { pattern: 'd(\\w)', replacement: 'd \\1', flags: '' },
    );
    expect(ruleSql({ find: 'sin', replace: 'sine', wholeWord: true }).pattern).toBe(
      '(?<![[:alnum:]_])(?:sin)(?![[:alnum:]_])',
    );
  });

  it('realigns rewritten segments, keeping unchanged word timings and dropping emptied ones', () => {
    const seg = {
      startSec: 10,
      endSec: 12,
      text: 'Ask the doctor about it.',
      words: [
        { w: 'Ask', s: 10, e: 10.4 },
        { w: 'the', s: 10.4, e: 10.6 },
        { w: 'doctor', s: 10.7, e: 11.2 },
        { w: 'about', s: 11.3, e: 11.6 },
        { w: 'it.', s: 11.6, e: 12 },
      ],
    };
    const untouched = { ...seg, text: 'nothing here', words: [] };
    const emptied = { ...seg, text: 'um', words: [{ w: 'um', s: 10, e: 11 }] };
    const out = realignSegments(
      [seg, untouched, emptied],
      [' Ask the dr about it. ', 'nothing here', ' '],
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(untouched);
    expect(out[0]!.text).toBe('Ask the dr about it.');
    expect(out[0]!.words).toEqual([
      seg.words[0],
      seg.words[1],
      { w: 'dr', s: 10.7, e: 11.2 },
      seg.words[3],
      seg.words[4],
    ]);
  });

  it('describes counts and skipped rules for the job result', () => {
    expect(
      describeRuleCounts([
        { find: 'doctor', replace: 'dr', count: 2 },
        { find: 'um', replace: '', count: 1 },
        { find: 'x', replace: 'y', count: 0 },
      ]),
    ).toBe('rules made 3 replacements (doctor → dr ×2, um → "" ×1)');
    expect(describeRuleCounts([{ find: 'x', replace: 'y', count: 0 }])).toBeNull();
    expect(
      describeRuleCounts(
        [{ find: 'x', replace: 'y', count: 0 }],
        [{ find: '(a*)\\1', replace: '' }],
      ),
    ).toBe('skipped 1 rule that failed or took too long ((a*)\\1)');
  });
});
