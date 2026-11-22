import { transcriptRuleError } from '@autologger/contract';
import { describe, expect, it } from 'vitest';
import {
  applyRulesToText,
  applyTranscriptRules,
  compileRules,
  describeRuleCounts,
} from './rules.ts';

const run = (text: string, ...rules: Parameters<typeof compileRules>[0]) =>
  applyRulesToText(text, compileRules(rules));

describe('transcript rules', () => {
  it('replaces literal text case-insensitively, in order, counting matches', () => {
    expect(
      run(
        'Doctor x over dsdt, doctor.',
        { find: 'doctor', replace: 'dr' },
        { find: 'dsdt', replace: 'ds dt' },
        { find: 'dr x', replace: 'dr(x)' }, // sees the output of the first rule
      ),
    ).toEqual({ text: 'dr(x) over ds dt, dr.', counts: [2, 1, 1] });
    // Literal find and replace: regex syntax and `$` mean nothing.
    expect(run('a.b a+b', { find: 'a.b', replace: '$1 $&' })).toEqual({
      text: '$1 $& a+b',
      counts: [1],
    });
    expect(run('Doctor doctor', { find: 'doctor', replace: 'dr', caseSensitive: true }).text).toBe(
      'Doctor dr',
    );
  });

  it('matches whole words only when asked, including around non-ASCII letters', () => {
    const rule = { find: 'sin', replace: 'sine', wholeWord: true };
    expect(run('sin x, using sin(x), sinh, résin', rule)).toEqual({
      text: 'sine x, using sine(x), sinh, résin',
      counts: [2],
    });
    expect(run('minuteus', { find: 'minuteus', replace: 'minus', wholeWord: true }).text).toBe(
      'minus',
    );
  });

  it('expands groups in regex replacements and ignores empty matches', () => {
    const rule = { find: '\\bc(\\d)x(?<p>\\d)\\b', replace: 'c$1 x^$<p>', regex: true };
    expect(run('c2x2', rule).text).toBe('c2 x^2');
    expect(run('dAdx and dsdt', { find: 'd(\\w)d(\\w)', replace: 'd$1 d$2', regex: true })).toEqual(
      { text: 'dA dx and ds dt', counts: [2] },
    );
    expect(run('abc', { find: 'x*', replace: '-', regex: true })).toEqual({
      text: 'abc',
      counts: [0],
    });
  });

  it('rejects invalid and nested-quantifier patterns', () => {
    expect(transcriptRuleError({ find: '(', replace: '', regex: true })).toMatch(/not a valid/);
    expect(transcriptRuleError({ find: '(a+)+$', replace: '', regex: true })).toMatch(/nests/);
    expect(transcriptRuleError({ find: '(\\w+\\s?)*', replace: '', regex: true })).toMatch(/nests/);
    expect(transcriptRuleError({ find: '(', replace: '' })).toBeNull(); // literal
    expect(transcriptRuleError({ find: 'd(\\w)d(\\w)', replace: '', regex: true })).toBeNull();
  });

  it('rewrites segments, keeping the timings of unchanged words', () => {
    const seg = {
      startSec: 10,
      endSec: 12,
      speaker: 'Speaker 1',
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
    const out = applyTranscriptRules(
      [seg, untouched, emptied],
      [
        { find: 'doctor', replace: 'dr', wholeWord: true },
        { find: 'um', replace: '', wholeWord: true },
      ],
    );
    expect(out.changed).toBe(2);
    expect(out.segments).toHaveLength(2); // the emptied segment is dropped
    expect(out.segments[1]).toBe(untouched);
    expect(out.segments[0]).toMatchObject({ speaker: 'Speaker 1', text: 'Ask the dr about it.' });
    expect(out.segments[0]!.words).toEqual([
      seg.words[0],
      seg.words[1],
      { w: 'dr', s: 10.7, e: 11.2 },
      seg.words[3],
      seg.words[4],
    ]);
    expect(out.counts).toEqual([
      { find: 'doctor', replace: 'dr', count: 1 },
      { find: 'um', replace: '', count: 1 },
    ]);
    expect(describeRuleCounts(out.counts)).toBe('2 replacements (doctor → dr ×1, um → "" ×1)');
    expect(describeRuleCounts([{ find: 'x', replace: 'y', count: 0 }])).toBeNull();
  });
});
