import { describe, expect, it } from 'vitest';
import { setCitationEnds, wikiCitations } from './wikiLinks.ts';

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

describe('setCitationEnds', () => {
  it('rewrites only the chosen ends, keeps every other byte, and skips code', () => {
    const body = [
      'Why? [end](/sessions/s1?t=10&to=6185 "hover") and [cell \\| x](/sessions/s1?to=6190&t=5)',
      '[open](/sessions/s1?t=6000) [keep](/sessions/s2?t=1&to=6185)',
      '`[inline](/sessions/s1?t=1&to=6185)`',
    ].join('\n');
    const seen: string[] = [];
    const out = setCitationEnds(body, (c) => {
      seen.push(c.label);
      return c.sessionId === 's1' ? 6184.8 : undefined;
    });
    expect(seen).toEqual(['end', 'cell | x', 'keep']);
    expect(out).toBe(
      body.replace('t=10&to=6185', 't=10&to=6184.8').replace('to=6190&t=5', 'to=6184.8&t=5'),
    );
  });
});
