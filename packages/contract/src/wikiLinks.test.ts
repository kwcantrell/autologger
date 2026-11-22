import { describe, expect, it } from 'vitest';
import { citationHref, unresolvedShortCitations, wikiCitations } from './wikiLinks.ts';

describe('wikiCitations', () => {
  it('parses ranges, single points and labels in order', () => {
    const body = [
      'Dana explains it [first time](/sessions/ses_abc123?t=61.5&to=95) and',
      '[again](/sessions/ses_def?t=7) — see also [[Dana]].',
      'Repeat: [first time](/sessions/ses_abc123?t=61.5&to=95 "hover").',
      '| a | [cell \\| quote](/sessions/ses_x?to=20&t=10) |',
    ].join('\n');
    expect(wikiCitations(body)).toEqual([
      { sessionId: 'ses_abc123', startSec: 61.5, endSec: 95, label: 'first time' },
      { sessionId: 'ses_def', startSec: 7, label: 'again' },
      { sessionId: 'ses_abc123', startSec: 61.5, endSec: 95, label: 'first time' },
      { sessionId: 'ses_x', startSec: 10, endSec: 20, label: 'cell | quote' },
    ]);
  });

  it('keeps an end before the start (lint reports it) and drops a non-numeric end', () => {
    expect(wikiCitations('[x](/sessions/s1?t=50&to=40) [y](/sessions/s1?t=5&to=soon)')).toEqual([
      { sessionId: 's1', startSec: 50, endSec: 40, label: 'x' },
      { sessionId: 's1', startSec: 5, label: 'y' },
    ]);
  });

  it('ignores session links without t, other links and code', () => {
    const body = [
      '[no t](/sessions/s1) [event](/sessions/s1?event=e1) [bad](/sessions/s1?t=-3)',
      '[abs](https://example.com/sessions/s1?t=3) [wiki](/wiki/w1?t=3)',
      '`[inline](/sessions/s1?t=3)`',
      '```',
      '[fenced](/sessions/s1?t=3&to=4)',
      '```',
    ].join('\n');
    expect(wikiCitations(body)).toEqual([]);
  });
});

describe('short citations', () => {
  const body = [
    'Intro [first](@1664-1760) and [@12.5-20] then [other](@ses_b:5-9 "hover") [@ses_c:7].',
    'Long [x](/sessions/ses_d?t=1) and [en dash](@30–40); not [@abc] or [y](@1-2-3).',
    '`[code](@1-2)` [@99](/sessions/ses_e?t=99) [@3][ref]',
  ].join('\n');

  it('resolves relative forms to the page session, in body order with long links', () => {
    expect(wikiCitations(body, 'ses_a')).toEqual([
      { sessionId: 'ses_a', startSec: 1664, endSec: 1760, label: 'first' },
      { sessionId: 'ses_a', startSec: 12.5, endSec: 20, label: '' },
      { sessionId: 'ses_b', startSec: 5, endSec: 9, label: 'other' },
      { sessionId: 'ses_c', startSec: 7, label: '' },
      { sessionId: 'ses_d', startSec: 1, label: 'x' },
      { sessionId: 'ses_a', startSec: 30, endSec: 40, label: 'en dash' },
      { sessionId: 'ses_e', startSec: 99, label: '@99' },
    ]);
  });

  it('drops relative forms without a page session and reports them', () => {
    expect(wikiCitations(body).map((c) => c.sessionId)).toEqual([
      'ses_b',
      'ses_c',
      'ses_d',
      'ses_e',
    ]);
    expect(unresolvedShortCitations(body)).toEqual([
      '[first](@1664-1760)',
      '[@12.5-20]',
      '[en dash](@30–40)',
    ]);
    expect(unresolvedShortCitations(body, 'ses_a')).toEqual([]);
  });

  it('builds the long href', () => {
    expect(citationHref({ sessionId: 'ses_a', startSec: 1.5, endSec: 9 })).toBe(
      '/sessions/ses_a?t=1.5&to=9',
    );
    expect(citationHref({ sessionId: 'ses_a', startSec: 3 })).toBe('/sessions/ses_a?t=3');
  });
});
