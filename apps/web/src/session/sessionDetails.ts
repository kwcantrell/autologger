// The session details form as plain data: built from a snapshot of the session taken when the
// dialog opens, and turned back into a sessions.update patch of only what the user changed, so
// edits made elsewhere meanwhile (another tab, an agent) are not overwritten.

import type { OpInput, Session } from '@autologger/contract';
import { formatFrames, parseTimecode } from '@/lib/timecode';

export interface DetailsForm {
  title: string;
  episode: string;
  /** YYYY-MM-DD, or '' for no date. */
  date: string;
  notes: string;
  fps: number;
  startTc: string;
}

type Base = Pick<
  Session,
  'id' | 'title' | 'episode' | 'episodeDate' | 'notes' | 'frameRate' | 'startOffsetFrames'
>;

export const startTcOf = (s: Base) => formatFrames(s.startOffsetFrames, s.frameRate);

export function formFromSession(s: Base): DetailsForm {
  return {
    title: s.title,
    episode: s.episode,
    date: s.episodeDate ?? '',
    notes: s.notes,
    fps: s.frameRate,
    startTc: startTcOf(s),
  };
}

/** The same timecode digits in the form `fps` writes them (29.97 and 59.94 use ';'). */
export function reformatStartTc(startTc: string, fps: number): string {
  const f = parseTimecode(startTc, fps);
  return f == null ? startTc : formatFrames(f, fps);
}

/** Whether the form changes the session clock (frame rate or start timecode). */
export const clockChanged = (base: Base, form: DetailsForm) =>
  form.fps !== base.frameRate || form.startTc.trim() !== startTcOf(base);

/** sessions.update input with only the fields the form changed from `base`. */
export function buildPatch(base: Base, form: DetailsForm): OpInput<'sessions.update'> {
  const date = form.date || null;
  return {
    sessionId: base.id,
    ...(form.title.trim() !== base.title && { title: form.title.trim() }),
    ...(form.episode.trim() !== base.episode && { episode: form.episode.trim() }),
    ...(date !== base.episodeDate && { episodeDate: date }),
    ...(form.notes !== base.notes && { notes: form.notes }),
    ...(form.fps !== base.frameRate && { frameRate: form.fps }),
    // Sent with a frame rate change too, so the server re-reads the start offset at the new rate.
    ...(clockChanged(base, form) && { startTimecode: form.startTc.trim() }),
  };
}

/** Why the form can't be saved, or null. */
export function formError(base: Base, form: DetailsForm): string | null {
  if (!form.title.trim()) return 'Enter a title.';
  if (clockChanged(base, form) && parseTimecode(form.startTc, form.fps) == null)
    return `Use HH:MM:SS:FF for the start timecode, with frames below ${Math.round(form.fps)}.`;
  return null;
}

const LABELS: [keyof DetailsForm, string][] = [
  ['title', 'title'],
  ['episode', 'episode'],
  ['date', 'date'],
  ['notes', 'notes'],
  ['fps', 'frame rate'],
  ['startTc', 'start timecode'],
];

/** Fields the session changed elsewhere since `base` was taken, by label. */
export function changedElsewhere(base: Base, live: Base): string[] {
  const a = formFromSession(base);
  const b = formFromSession(live);
  return LABELS.filter(([k]) => a[k] !== b[k]).map(([, label]) => label);
}
