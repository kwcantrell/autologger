import { MAX_CLIP_SEC, MAX_COMPILATION_CLIPS } from '@autologger/contract';
import { describe, expect, it } from 'vitest';
import { citationCandidates, DEFAULT_CLIP_SEC, limitProblem, planClips } from './clipPlan';

const yt = {
  id: 'ses_yt',
  title: 'Ep 1',
  sourceKind: 'youtube' as const,
  sourceUrl: 'https://www.youtube.com/watch?v=abc',
  audioSeconds: 3600,
};
const rec = {
  ...yt,
  id: 'ses_rec',
  title: 'Live',
  sourceKind: 'recorded' as const,
  sourceUrl: null,
};

describe('planClips', () => {
  it('keeps YouTube ranges, defaults a missing end and clamps to the video', () => {
    const { clips, skipped } = planClips(
      [
        { sessionId: 'ses_yt', startSec: 10, endSec: 40, label: 'a' },
        { sessionId: 'ses_yt', startSec: 100, label: 'no end' },
        { sessionId: 'ses_yt', startSec: 3580, label: 'near the end' },
        { sessionId: 'ses_yt', startSec: 0, endSec: 3000, label: 'long' },
      ],
      [yt],
    );
    expect(skipped).toEqual([]);
    expect(clips.map((c) => [c.startSec, c.endSec, c.defaultLength, c.trimmed])).toEqual([
      [10, 40, false, false],
      [100, 100 + DEFAULT_CLIP_SEC, true, false],
      [3580, 3600, true, true],
      [0, MAX_CLIP_SEC, false, true],
    ]);
  });

  it('leaves out other sources, unknown sessions, ranges past the video and repeats', () => {
    const { clips, skipped } = planClips(
      [
        { sessionId: 'ses_rec', startSec: 5, endSec: 20, label: 'x' },
        { sessionId: 'ses_gone', startSec: 5, endSec: 20, label: 'y' },
        { sessionId: 'ses_yt', startSec: 4000, endSec: 4010, label: 'z' },
        { sessionId: 'ses_yt', startSec: 5, endSec: 20, label: 'once' },
        { sessionId: 'ses_yt', startSec: 5, endSec: 20, label: 'again' },
      ],
      [yt, rec],
    );
    expect(clips.map((c) => c.label)).toEqual(['once']);
    expect(skipped.map((s) => s.reason)).toEqual([
      expect.stringContaining('not imported from YouTube'),
      expect.stringContaining('not in this show'),
      expect.stringContaining('outside the video'),
    ]);
  });
});

describe('limitProblem', () => {
  it('checks the server limits', () => {
    expect(limitProblem([{ startSec: 0, endSec: 10 }])).toBeNull();
    expect(limitProblem([])).toMatch(/at least one/);
    const many = Array.from({ length: MAX_COMPILATION_CLIPS + 1 }, () => ({
      startSec: 0,
      endSec: 5,
    }));
    expect(limitProblem(many)).toMatch(/at most 100 clips/);
    const long = Array.from({ length: 10 }, () => ({ startSec: 0, endSec: MAX_CLIP_SEC }));
    expect(limitProblem(long)).toMatch(/at most 3 hours/);
  });
});

describe('citationCandidates', () => {
  it('labels citations with the text after the link, else the link text', () => {
    const body = [
      'Intro [[Tom]] text.',
      '- [Ep1 00:27:44–00:29:20](/sessions/ses_a?t=1664&to=1760) — ten thousand **hours** with [[Tom Segura|Tom]]',
      '- [the dog](/sessions/ses_b?t=12.5) and [again](/sessions/ses_b?t=99&to=120): second one',
      '`[code](/sessions/ses_c?t=1)`',
    ].join('\n');
    expect(citationCandidates(body)).toEqual([
      { sessionId: 'ses_a', startSec: 1664, endSec: 1760, label: 'ten thousand hours with Tom' },
      { sessionId: 'ses_b', startSec: 12.5, label: 'the dog' },
      { sessionId: 'ses_b', startSec: 99, endSec: 120, label: 'second one' },
    ]);
  });

  it('resolves short citations against the page session', () => {
    const body = [
      '- [@1664-1760] — ten thousand hours',
      '- [the dog](@ses_b:12.5) and [again](@99-120): second one [@5]',
    ].join('\n');
    expect(citationCandidates(body, 'ses_a')).toEqual([
      { sessionId: 'ses_a', startSec: 1664, endSec: 1760, label: 'ten thousand hours' },
      { sessionId: 'ses_b', startSec: 12.5, label: 'the dog' },
      { sessionId: 'ses_a', startSec: 99, endSec: 120, label: 'again' },
      { sessionId: 'ses_a', startSec: 5, label: '' },
    ]);
  });
});
