// The session details form → sessions.update patch.

import { describe, expect, it } from 'vitest';
import {
  buildPatch,
  changedElsewhere,
  formError,
  formFromSession,
  reformatStartTc,
} from './sessionDetails';

const base = {
  id: 'ses_1',
  title: 'Ep 7',
  episode: '7',
  episodeDate: '2026-11-22',
  notes: '',
  frameRate: 29.97,
  startOffsetFrames: 0,
};

describe('buildPatch', () => {
  it('sends nothing but the id for an untouched form', () => {
    expect(buildPatch(base, formFromSession(base))).toEqual({ sessionId: 'ses_1' });
  });

  it('sends only edited fields, trimmed, with an empty date as null', () => {
    const form = { ...formFromSession(base), title: ' Ep 7b ', notes: 'n', date: '' };
    expect(buildPatch(base, form)).toEqual({
      sessionId: 'ses_1',
      title: 'Ep 7b',
      notes: 'n',
      episodeDate: null,
    });
  });

  it('sends the start timecode with a frame rate change, in the new rate form', () => {
    const start = { ...base, startOffsetFrames: 30 * 3600 }; // 01:00:00;00 at 29.97
    const form = formFromSession(start);
    expect(form.startTc).toBe('01:00:00;00');
    const next = { ...form, fps: 25, startTc: reformatStartTc(form.startTc, 25) };
    expect(next.startTc).toBe('01:00:00:00');
    expect(buildPatch(start, next)).toEqual({
      sessionId: 'ses_1',
      frameRate: 25,
      startTimecode: '01:00:00:00',
    });
  });

  it('keeps an unparseable timecode as typed and reports it', () => {
    expect(reformatStartTc('01:00:00:29', 25)).toBe('01:00:00:29');
    const form = { ...formFromSession(base), fps: 25, startTc: '01:00:00:29' };
    expect(formError(base, form)).toMatch(/frames below 25/);
    expect(formError(base, { ...formFromSession(base), title: ' ' })).toBe('Enter a title.');
  });
});

describe('changedElsewhere', () => {
  it('lists fields the live session changed since the snapshot', () => {
    expect(changedElsewhere(base, base)).toEqual([]);
    expect(changedElsewhere(base, { ...base, notes: 'agent', frameRate: 25 })).toEqual([
      'notes',
      'frame rate',
      'start timecode',
    ]);
  });
});
