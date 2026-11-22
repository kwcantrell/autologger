// Turns search hits into the clips of a "Make video" (MakeVideoDialog): one compilation per show,
// one clip per moment. A topic is a range already; a transcript line or an event is a point, so it
// gets a window around it — LEAD_SEC before (the set-up) to TAIL_SEC after (what follows), or to
// the line's end when it runs longer. Windows that overlap in one session become one clip, so the
// video never plays the same footage twice. Clips run in episode order, then by time.

import { MAX_CLIP_SEC } from '@autologger/contract';
import { type ClipCandidate, DEFAULT_CLIP_SEC } from '@/routes/compilations/clipPlan';
import { type MomentHit, momentLabel } from './searchLinks';

export const LEAD_SEC = 10;
export const TAIL_SEC = 30;

/** Explains the windows in the dialog. */
export const WINDOW_NOTE = `Topics play their whole range (${DEFAULT_CLIP_SEC} s when they have no end). Transcript lines and events are moments, not ranges: each clip starts ${LEAD_SEC} s before the moment and runs ${TAIL_SEC} s after it (or to the end of the line), so the set-up and the reaction are in. Overlapping moments in one session become one clip.`;

export interface ShowMoments {
  showId: string;
  showName: string;
  /** Moments with a session and a time, the ones that can become clips. */
  moments: MomentHit[];
}

/** Moment hits grouped by show, in the order the shows first appear in the results. */
export function momentsByShow(moments: MomentHit[]): ShowMoments[] {
  const by = new Map<string, ShowMoments>();
  for (const m of moments) {
    if (!m.sessionId || m.atSec == null) continue;
    let g = by.get(m.showId);
    if (!g) {
      g = { showId: m.showId, showName: m.showName, moments: [] };
      by.set(m.showId, g);
    }
    g.moments.push(m);
  }
  return [...by.values()];
}

const plain = (snippet: string) => snippet.replace(/[«»]/g, '').replace(/\s+/g, ' ').trim();

function clipWindow(h: MomentHit): { startSec: number; endSec: number } {
  const at = h.atSec ?? 0;
  if (h.kind === 'topic')
    return {
      startSec: at,
      endSec: h.endSec != null && h.endSec > at ? h.endSec : at + DEFAULT_CLIP_SEC,
    };
  return { startSec: Math.max(0, at - LEAD_SEC), endSec: Math.max(at + TAIL_SEC, h.endSec ?? 0) };
}

function label(h: MomentHit): string {
  const who = momentLabel(h).replace(/ · [\d:]+$/, '');
  return h.kind === 'topic' ? `Topic: ${h.title.trim()}` : `${who}: ${plain(h.snippet)}`;
}

/** One show's moments as clip candidates (ends past the video are clamped by planClips). */
export function searchClipCandidates(moments: MomentHit[]): ClipCandidate[] {
  const items = moments
    .filter((m) => m.sessionId && m.atSec != null)
    .map((m) => ({ sessionId: m.sessionId as string, ...clipWindow(m), label: label(m), hit: m }))
    .sort(
      (a, b) =>
        (a.hit.sessionDate ?? '').localeCompare(b.hit.sessionDate ?? '') ||
        // Same-day imports: "Ep2" before "Ep10".
        (a.hit.sessionTitle ?? '').localeCompare(b.hit.sessionTitle ?? '', undefined, {
          numeric: true,
        }) ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.startSec - b.startSec,
    );
  const out: { sessionId: string; startSec: number; endSec: number; labels: string[] }[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    const end = Math.max(prev?.endSec ?? 0, it.endSec);
    if (
      prev?.sessionId === it.sessionId &&
      it.startSec <= prev.endSec &&
      end - prev.startSec <= MAX_CLIP_SEC
    ) {
      prev.endSec = end;
      prev.labels.push(it.label);
    } else {
      const { sessionId, startSec, endSec } = it;
      out.push({ sessionId, startSec, endSec, labels: [it.label] });
    }
  }
  return out.map(({ labels, ...c }) => ({ ...c, label: labels.join(' · ').slice(0, 200) }));
}
