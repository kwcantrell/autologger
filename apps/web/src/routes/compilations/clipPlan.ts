// Turns ranges people already have (a wiki page's citations, a session's topics) into the clips of a
// compilations.create call: each range is checked against the sessions the web app knows (only
// YouTube imports with stored audio can be compiled) and fitted to the server's limits. The server
// checks again; this only lets the dialog say up front what will and won't be in the video.

import {
  MAX_CLIP_SEC,
  MAX_COMPILATION_CLIPS,
  MAX_COMPILATION_SEC,
  MIN_CLIP_SEC,
  type Session,
  wikiCitations,
} from '@autologger/contract';

/** A range without an end (a citation with no `to`, a zero-length topic) gets this many seconds. */
export const DEFAULT_CLIP_SEC = 60;

export interface ClipCandidate {
  sessionId: string;
  startSec: number;
  /** Omitted when the source has no end: the clip runs DEFAULT_CLIP_SEC. */
  endSec?: number;
  label: string;
}

/** An in-app session link, `[label](/sessions/<id>?t=…)`, as written in a page line. */
const SESSION_LINK =
  /\[(?:\\.|[^\\[\]\n])*\]\(\s*\/sessions\/([A-Za-z0-9_-]+)\/?\?([^\s)]*)[^)\n]*\)/g;

/** Markdown inline syntax reduced to its text, for a one-line clip label. */
function plainText(md: string): string {
  return md
    .replace(/\[\[([^[\]|\n]+?)(?:\\?\|([^[\]\n]+?))?\]\]/g, (_m, t: string, l?: string) => l ?? t)
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\*+|`+|__/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s—–\-:;,.|]+/, '')
    .trim();
}

/**
 * The clips of a wiki page: its citations (wikiCitations). A citation that ends its line is
 * labelled with the text after it ("[Ep 1 00:27:44–00:29:20](…) — ten thousand hours" → "ten
 * thousand hours"), which says what the moment is; otherwise with its link text.
 */
export function citationCandidates(bodyMd: string): ClipCandidate[] {
  const written: { sessionId: string; query: string; after: string; used: boolean }[] = [];
  for (const line of bodyMd.split('\n')) {
    const links = [...line.matchAll(SESSION_LINK)];
    links.forEach((m, i) => {
      // Only the last link of a line is followed by its description; between links is glue.
      const last = i === links.length - 1;
      written.push({
        sessionId: m[1] ?? '',
        query: m[2] ?? '',
        after: last ? plainText(line.slice((m.index ?? 0) + m[0].length)) : '',
        used: false,
      });
    });
  }
  return wikiCitations(bodyMd).map((c) => {
    const w = written.find(
      (x) =>
        !x.used &&
        x.sessionId === c.sessionId &&
        Number(new URLSearchParams(x.query).get('t')) === c.startSec,
    );
    if (w) w.used = true;
    return {
      sessionId: c.sessionId,
      startSec: c.startSec,
      ...(c.endSec !== undefined ? { endSec: c.endSec } : {}),
      label: (w?.after || c.label).slice(0, 200),
    };
  });
}

export interface PlannedClip {
  /** Stable key in the candidate order (duplicates removed). */
  key: string;
  sessionId: string;
  sessionTitle: string;
  startSec: number;
  endSec: number;
  label: string;
  /** The end was not given: DEFAULT_CLIP_SEC were used (clamped to the video). */
  defaultLength: boolean;
  /** The range was cut to fit the video or the per-clip maximum. */
  trimmed: boolean;
}

export interface SkippedClip {
  key: string;
  sessionTitle: string | null;
  startSec: number;
  label: string;
  reason: string;
}

export interface ClipPlan {
  clips: PlannedClip[];
  skipped: SkippedClip[];
}

const round = (n: number) => Math.round(n * 100) / 100;

export function planClips(
  candidates: ClipCandidate[],
  sessions: Pick<Session, 'id' | 'title' | 'sourceKind' | 'sourceUrl' | 'audioSeconds'>[],
): ClipPlan {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const clips: PlannedClip[] = [];
  const skipped: SkippedClip[] = [];
  for (const [i, c] of candidates.entries()) {
    const s = byId.get(c.sessionId);
    const sessionTitle = s ? s.title.trim() || 'Untitled session' : null;
    const key = `${i}`;
    const why = !s
      ? 'The session is not in this show (or was deleted).'
      : s.sourceKind !== 'youtube' || !s.sourceUrl
        ? 'The session was not imported from YouTube, so there is no video to cut.'
        : !(s.audioSeconds > 0)
          ? 'The session’s YouTube audio is not stored yet.'
          : null;
    const skip = (reason: string) =>
      skipped.push({ key, sessionTitle, startSec: c.startSec, label: c.label, reason });
    if (!s || why) {
      skip(why as string);
      continue;
    }
    const videoEnd = s.audioSeconds;
    const defaultLength = c.endSec === undefined || c.endSec <= c.startSec;
    const wanted = defaultLength ? c.startSec + DEFAULT_CLIP_SEC : (c.endSec as number);
    const endSec = round(Math.min(wanted, videoEnd, c.startSec + MAX_CLIP_SEC));
    const startSec = round(c.startSec);
    if (endSec - startSec < MIN_CLIP_SEC) {
      skip('The range is outside the video.');
      continue;
    }
    const dup = `${c.sessionId}@${startSec}-${endSec}`;
    if (seen.has(dup)) continue; // the same range cited twice plays once
    seen.add(dup);
    clips.push({
      key,
      sessionId: s.id,
      sessionTitle: sessionTitle as string,
      startSec,
      endSec,
      label: c.label.trim().slice(0, 200),
      defaultLength,
      trimmed: endSec < round(wanted),
    });
  }
  return { clips, skipped };
}

/** Why the chosen clips can't be sent as they are, or null when they fit the server's limits. */
export function limitProblem(clips: Pick<PlannedClip, 'startSec' | 'endSec'>[]): string | null {
  if (clips.length === 0) return 'Choose at least one clip.';
  if (clips.length > MAX_COMPILATION_CLIPS)
    return `A compilation holds at most ${MAX_COMPILATION_CLIPS} clips; ${clips.length} are chosen.`;
  if (totalSec(clips) > MAX_COMPILATION_SEC)
    return `A compilation may run at most ${MAX_COMPILATION_SEC / 3600} hours; untick some clips.`;
  return null;
}

export const totalSec = (clips: Pick<PlannedClip, 'startSec' | 'endSec'>[]) =>
  clips.reduce((n, c) => n + (c.endSec - c.startSec), 0);
