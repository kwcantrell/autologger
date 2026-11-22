// Wiki labels, formatting, link resolution and the write hooks shared by the wiki screens.

import {
  normTitle,
  type WikiKind,
  type WikiPageSummary,
  wikiCitations,
} from '@autologger/contract';
import { useMemo } from 'react';
import { qk, useOpMutation, useSessions, useWikiList } from '@/api/queries';

export const WIKI_KIND_LABEL: Record<WikiKind, string> = {
  person: 'Person',
  topic: 'Topic',
  bit: 'Running bit',
  session: 'Session',
  question: 'Question',
};

export const wikiHref = (pageId: string) => `/wiki/${encodeURIComponent(pageId)}`;

/** Same normalisation as the server's title matching (trim, lower-case, collapse spaces). */
export { normTitle };

/** Lower-case with accents dropped, so "jose" finds "José" (list filter). */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export interface ResolvedPage {
  id: string;
  title: string;
}
export type WikiResolver = (title: string) => ResolvedPage | null;

/** `[[Title]]` resolution over a show's page titles and aliases, case-insensitive. */
export function useWikiResolver(showId: string | undefined): {
  resolve: WikiResolver;
  pages: WikiPageSummary[];
} {
  const list = useWikiList(showId);
  return useMemo(() => {
    const pages = list.data ?? [];
    const map = new Map<string, ResolvedPage>();
    for (const p of pages) map.set(normTitle(p.title), { id: p.id, title: p.title });
    for (const p of pages)
      for (const a of p.aliases)
        if (!map.has(normTitle(a))) map.set(normTitle(a), { id: p.id, title: p.title });
    return { pages, resolve: (title: string) => map.get(normTitle(title)) ?? null };
  }, [list.data]);
}

/** Title of a cited session: null when the show has no such session, undefined while loading. */
export type SessionTitle = (sessionId: string) => string | null | undefined;

/**
 * Names the sessions a body cites from one sessions.list of its show (cached, shared with the
 * rest of the app), fetched only when the body has citations.
 */
export function useSessionTitles(showId: string, body: string): SessionTitle {
  const cites = useMemo(() => wikiCitations(body).length > 0, [body]);
  const sessions = useSessions(cites ? showId : undefined);
  return useMemo<SessionTitle>(() => {
    if (!sessions.data) return () => (sessions.isError ? null : undefined);
    const titles = new Map(sessions.data.map((s) => [s.id, s.title.trim() || 'Untitled session']));
    return (id) => titles.get(id) ?? null;
  }, [sessions.data, sessions.isError]);
}

export function useWikiUpsert() {
  return useOpMutation('wiki.upsert', {
    onSuccess: (page, _input, qc) => qc.setQueryData(qk.wikiPage(page.id), page),
    invalidate: (page, input) => [qk.wikiList(input.showId), qk.wikiRevisions(page.id)],
  });
}

export function useWikiRestore() {
  return useOpMutation('wiki.restore', {
    onSuccess: (page, _input, qc) => qc.setQueryData(qk.wikiPage(page.id), page),
    invalidate: (page) => [qk.wikiList(page.showId), qk.wikiRevisions(page.id)],
  });
}

export function useWikiDelete(showId: string) {
  return useOpMutation('wiki.delete', {
    onSuccess: (_d, input, qc) => qc.removeQueries({ queryKey: qk.wikiPage(input.pageId) }),
    invalidate: () => [qk.wikiList(showId)],
  });
}
