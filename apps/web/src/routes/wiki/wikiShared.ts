// Wiki labels, formatting, link resolution and the write hooks shared by the wiki screens.

import {
  normTitle,
  type WikiKind,
  type WikiPageSummary,
  wikiCitations,
} from '@autologger/contract';
import { useMemo } from 'react';
import {
  qk,
  useOpMutation,
  useSessionsOf,
  useWikiList,
  useWikiLists,
  type WikiScope,
  wikiScopeKey,
  wikiScopeOf,
} from '@/api/queries';
import { useActive } from '@/app/useActive';

export const WIKI_KIND_LABEL: Record<WikiKind, string> = {
  person: 'Person',
  topic: 'Topic',
  bit: 'Running bit',
  session: 'Session',
  question: 'Question',
};

/** Any page, show or team wiki: the page itself says which wiki holds it. */
export const wikiHref = (pageId: string) => `/wiki/${encodeURIComponent(pageId)}`;

/** The index of a team's shared wiki. */
export const teamWikiHref = (teamId: string) => `/teams/${encodeURIComponent(teamId)}/wiki`;

/** The index a page's "back" link and post-delete navigation go to. */
export const wikiIndexHref = (scope: WikiScope | undefined) =>
  scope?.teamId ? teamWikiHref(scope.teamId) : '/wiki';

/** Same normalisation as the server's title matching (trim, lower-case, collapse spaces). */
export { normTitle };

/** Lower-case with accents dropped, so "jose" finds "José" (list filter). */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  // Medium date ("Nov 22, 2026"), like the session meta lines and the wiki page header.
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
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

/** Normalised title or alias → page, titles winning over aliases. */
function namesOf(pages: WikiPageSummary[]): Map<string, ResolvedPage> {
  const map = new Map<string, ResolvedPage>();
  for (const p of pages) map.set(normTitle(p.title), { id: p.id, title: p.title });
  for (const p of pages)
    for (const a of p.aliases)
      if (!map.has(normTitle(a))) map.set(normTitle(a), { id: p.id, title: p.title });
  return map;
}

/** The team whose shared wiki a page of this scope can link (a show's team, or the team itself). */
export function useWikiTeamId(scope: WikiScope | undefined): string | undefined {
  const { allShows } = useActive();
  if (!scope) return undefined;
  return scope.teamId ?? allShows.find((s) => s.id === scope.showId)?.teamId;
}

/**
 * `[[Title]]` resolution as the server does it, case-insensitive: on a show page, the show's page
 * titles and aliases first, then the team wiki's; on a team page, the team wiki's, then a page of
 * the team's shows whose name only one show uses (among the shows this user can open — the server
 * counts every show). `pages` are the scope's own pages, `teamPages` the team wiki's (empty for a
 * team scope).
 */
export function useWikiResolver(scope: WikiScope | undefined): {
  resolve: WikiResolver;
  pages: WikiPageSummary[];
  teamPages: WikiPageSummary[];
} {
  const { allShows } = useActive();
  const teamId = useWikiTeamId(scope);
  const own = useWikiList(scope);
  const team = useWikiList(scope?.showId && teamId ? { teamId } : undefined);
  const teamShows = useMemo(
    () =>
      scope?.teamId
        ? allShows.filter((s) => s.teamId === scope.teamId).map((s) => ({ showId: s.id }))
        : [],
    [scope?.teamId, allShows],
  );
  const shows = useWikiLists(teamShows);
  return useMemo(() => {
    const pages = own.data ?? [];
    const teamPages = team.data ?? [];
    // On a team page: names exactly one show uses link down to that show's page.
    const down = new Map<string, ResolvedPage | null>();
    for (const list of shows.data ?? [])
      for (const [n, p] of namesOf(list)) down.set(n, down.has(n) ? null : p);
    const map = new Map([
      ...[...down].filter((e): e is [string, ResolvedPage] => e[1] !== null),
      ...namesOf(teamPages),
      ...namesOf(pages),
    ]);
    return { pages, teamPages, resolve: (title: string) => map.get(normTitle(title)) ?? null };
  }, [own.data, team.data, shows.data]);
}

/** Title of a cited session: null when the show has no such session, undefined while loading. */
export type SessionTitle = (sessionId: string) => string | null | undefined;

/**
 * Names the sessions a body cites from the cached sessions.list of its show (for a team page, of
 * every show of the team the user can open), fetched only when the body has citations.
 * `sessionId` is the page's own session, which short citations resolve to.
 */
export function useSessionTitles(
  scope: WikiScope | undefined,
  body: string,
  sessionId?: string | null,
): SessionTitle {
  const { allShows } = useActive();
  const cites = useMemo(() => wikiCitations(body, sessionId).length > 0, [body, sessionId]);
  const showIds = useMemo(
    () =>
      !cites || !scope
        ? []
        : scope.showId
          ? [scope.showId]
          : allShows.filter((s) => s.teamId === scope.teamId).map((s) => s.id),
    [cites, scope, allShows],
  );
  const sessions = useSessionsOf(showIds);
  return useMemo<SessionTitle>(() => {
    if (!sessions.data) return () => (sessions.isError ? null : undefined);
    const titles = new Map(sessions.data.map((s) => [s.id, s.title.trim() || 'Untitled session']));
    return (id) => titles.get(id) ?? null;
  }, [sessions.data, sessions.isError]);
}

export function useWikiUpsert() {
  return useOpMutation('wiki.upsert', {
    onSuccess: (page, _input, qc) => qc.setQueryData(qk.wikiPage(page.id), page),
    invalidate: (page, input) => [
      qk.wikiList(
        wikiScopeKey(input.showId ? { showId: input.showId } : { teamId: input.teamId! }),
      ),
      qk.wikiRevisions(page.id),
    ],
  });
}

export function useWikiRestore() {
  return useOpMutation('wiki.restore', {
    onSuccess: (page, _input, qc) => qc.setQueryData(qk.wikiPage(page.id), page),
    invalidate: (page) => [qk.wikiList(wikiScopeKey(wikiScopeOf(page))), qk.wikiRevisions(page.id)],
  });
}

export function useWikiDelete(scope: WikiScope | undefined) {
  return useOpMutation('wiki.delete', {
    onSuccess: (_d, input, qc) => qc.removeQueries({ queryKey: qk.wikiPage(input.pageId) }),
    invalidate: () => [qk.wikiList(wikiScopeKey(scope))],
  });
}

/** wiki.move: the page leaves one wiki's lists and joins the other's. */
export function useWikiMove(from: WikiScope | undefined) {
  return useOpMutation('wiki.move', {
    onSuccess: (page, _input, qc) => qc.setQueryData(qk.wikiPage(page.id), page),
    invalidate: (page) => [
      qk.wikiList(wikiScopeKey(from)),
      qk.wikiList(wikiScopeKey(wikiScopeOf(page))),
      qk.wikiRevisions(page.id),
    ],
  });
}
