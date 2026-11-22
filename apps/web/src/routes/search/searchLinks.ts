// Where a search hit leads, and how it is labelled. Shared by the palette and the /search page.

import type { SearchHit } from '@autologger/contract';
import { fmtShort } from '@/lib/timecode';

/** How long typing must pause before a search runs. */
export const SEARCH_DEBOUNCE_MS = 200;
export const MIN_QUERY = 2;

export const isSearchable = (q: string) => q.trim().length >= MIN_QUERY;

export type MomentHit = SearchHit & { kind: 'transcript' | 'topic' | 'event' };
export const isMoment = (h: SearchHit): h is MomentHit =>
  h.kind === 'transcript' || h.kind === 'topic' || h.kind === 'event';

export const sessionHref = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`;
export const wikiHref = (pageId: string) => `/wiki/${encodeURIComponent(pageId)}`;
export const searchPageHref = (q: string) => `/search?q=${encodeURIComponent(q.trim())}`;

/** `/sessions/:id?t=<sec>` (+ `&event=` / `&topic=`), the workspace seeks to `t`. */
export function momentHref(h: MomentHit): string {
  const base = sessionHref(h.sessionId ?? '');
  const params = new URLSearchParams();
  if (h.atSec != null) params.set('t', String(Math.round(h.atSec * 100) / 100));
  if (h.kind === 'event') params.set('event', h.id);
  if (h.kind === 'topic') params.set('topic', h.id);
  const s = params.toString();
  return s ? `${base}?${s}` : base;
}

export function hitHref(h: SearchHit): string {
  if (h.kind === 'wiki') return wikiHref(h.id);
  if (h.kind === 'session') return sessionHref(h.id);
  return momentHref(h as MomentHit);
}

/** `Speaker 3 · 1:12:03`, `Topic · 0:41`, `Laugh · 12:03` (an event's category). */
export function momentLabel(h: MomentHit): string {
  let who: string;
  if (h.kind === 'transcript') {
    const s = h.title.trim();
    who = /^\d+$/.test(s) ? `Speaker ${s}` : s || 'Speaker';
  } else if (h.kind === 'topic') who = 'Topic';
  else who = h.title.trim() || 'Event';
  return h.atSec == null ? who : `${who} · ${fmtShort(h.atSec)}`;
}

export interface GroupedHits {
  sessions: SearchHit[];
  moments: MomentHit[];
  wiki: SearchHit[];
}

export function groupHits(hits: SearchHit[]): GroupedHits {
  const out: GroupedHits = { sessions: [], moments: [], wiki: [] };
  for (const h of hits) {
    if (h.kind === 'session') out.sessions.push(h);
    else if (h.kind === 'wiki') out.wiki.push(h);
    else if (isMoment(h)) out.moments.push(h);
  }
  return out;
}

export const untitled = (t: string | null | undefined) => t?.trim() || 'Untitled session';
