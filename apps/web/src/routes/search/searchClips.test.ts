import { describe, expect, it } from 'vitest';
import { momentsByShow, searchClipCandidates } from './searchClips';
import type { MomentHit } from './searchLinks';

const hit = (h: Partial<MomentHit> & Pick<MomentHit, 'kind' | 'atSec'>): MomentHit => ({
  id: `${h.kind}${h.atSec}`,
  sessionId: 'ses_a',
  showId: 'shw_1',
  sessionTitle: 'Ep 1',
  sessionDate: '2026-01-02',
  showName: 'Tom Talks',
  title: '1',
  snippet: 'the «bombing» story',
  endSec: null,
  rank: 1,
  ...h,
});

describe('searchClipCandidates', () => {
  it('windows points, keeps topic ranges, merges overlaps and orders by episode', () => {
    const c = searchClipCandidates([
      hit({ kind: 'transcript', atSec: 500, endSec: 503, title: 'Tom' }),
      hit({ kind: 'topic', atSec: 100, endSec: 220, title: 'Bombing' }),
      hit({ kind: 'transcript', atSec: 5, endSec: 60 }),
      hit({ kind: 'event', atSec: 520, title: 'Laugh', snippet: '«bombing»' }),
      hit({ kind: 'topic', atSec: 50, sessionId: 'ses_b', sessionDate: '2026-01-01', title: 'X' }),
    ]);
    const sameDay = searchClipCandidates([
      hit({ kind: 'event', atSec: 100, sessionId: 'ses_10', sessionTitle: 'Ep10' }),
      hit({ kind: 'event', atSec: 100, sessionId: 'ses_2', sessionTitle: 'Ep2' }),
    ]);
    expect(sameDay.map((x) => x.sessionId)).toEqual(['ses_2', 'ses_10']);
    expect(c).toEqual([
      { sessionId: 'ses_b', startSec: 50, endSec: 110, label: 'Topic: X' },
      { sessionId: 'ses_a', startSec: 0, endSec: 60, label: 'Speaker 1: the bombing story' },
      { sessionId: 'ses_a', startSec: 100, endSec: 220, label: 'Topic: Bombing' },
      {
        sessionId: 'ses_a',
        startSec: 490,
        endSec: 550,
        label: 'Tom: the bombing story · Laugh: bombing',
      },
    ]);
  });

  it('groups by show and drops hits without a time', () => {
    const groups = momentsByShow([
      hit({ kind: 'event', atSec: 1 }),
      hit({ kind: 'event', atSec: 2, showId: 'shw_2', showName: 'Other' }),
      hit({ kind: 'event', atSec: null }),
    ]);
    expect(groups.map((g) => [g.showName, g.moments.length])).toEqual([
      ['Tom Talks', 1],
      ['Other', 1],
    ]);
  });
});
