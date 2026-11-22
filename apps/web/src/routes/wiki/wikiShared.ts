// Wiki labels, formatting, link resolution and the write hooks shared by the wiki screens.

import type { WikiKind, WikiPageSummary } from '@autologger/contract';
import { useMemo } from 'react';
import { qk, useOpMutation, useWikiList } from '@/api/queries';

export const WIKI_KIND_LABEL: Record<WikiKind, string> = {
  person: 'Person',
  topic: 'Topic',
  bit: 'Running bit',
  session: 'Session',
};

export const wikiHref = (pageId: string) => `/wiki/${encodeURIComponent(pageId)}`;

/** Same normalisation as the server's title matching (trim, lower-case, collapse spaces). */
export const normTitle = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');

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

export function useWikiUpsert() {
  return useOpMutation('wiki.upsert', {
    onSuccess: (page, _input, qc) => qc.setQueryData(qk.wikiPage(page.id), page),
    invalidate: (page) => [qk.wikiList(page.showId), qk.wikiRevisions(page.id)],
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
