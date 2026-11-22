// TanStack Query hooks over the ops registry. One key factory, so live updates (live.ts)
// and mutations write to the same cache entries the screens read.

import type {
  DashboardQuery,
  FullOpInput,
  OpInput,
  OpName,
  OpResult,
  Via,
  WikiKind,
  WikiList,
  WikiListItem,
} from '@autologger/contract';
import {
  type QueryClient,
  type QueryKey,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { getCapabilities, RpcError, rpc } from './rpc';

export const qk = {
  capabilities: ['capabilities'] as const,
  me: ['me'] as const,
  teams: ['teams'] as const,
  team: (teamId: string) => ['team', teamId] as const,
  shows: ['shows'] as const,
  show: (showId: string) => ['show', showId] as const,
  categories: (showId: string) => ['categories', showId] as const,
  sessionsAll: ['sessions'] as const,
  sessions: (showId: string | undefined) => ['sessions', showId ?? 'all'] as const,
  session: (sessionId: string) => ['session', sessionId] as const,
  events: (sessionId: string) => ['events', sessionId] as const,
  transcript: (sessionId: string) => ['transcript', sessionId] as const,
  topics: (sessionId: string) => ['topics', sessionId] as const,
  dashboards: (sessionId: string) => ['dashboards', sessionId] as const,
  dashboardQueryAll: (sessionId: string) => ['dashboard-query', sessionId] as const,
  dashboardQuery: (sessionId: string, query: DashboardQuery) =>
    ['dashboard-query', sessionId, query] as const,
  media: (sessionId: string) => ['media', sessionId] as const,
  jobs: (sessionId: string) => ['jobs', sessionId] as const,
  changesAll: (sessionId: string) => ['changes', sessionId] as const,
  changes: (sessionId: string, via: Via | 'all') => ['changes', sessionId, via] as const,
  wikiList: (showId: string) => ['wiki', showId] as const,
  wikiPage: (pageId: string) => ['wiki-page', pageId] as const,
  wikiRevisions: (pageId: string) => ['wiki-revisions', pageId] as const,
  search: (input: OpInput<'search'>) => ['search', input] as const,
  tokens: ['tokens'] as const,
  companion: ['companion'] as const,
  adminUsers: ['admin-users'] as const,
};

type QOpts<T> = Omit<UseQueryOptions<T, RpcError, T, QueryKey>, 'queryKey' | 'queryFn'>;

/** The full (never compact) result of op N, as the web app asks for it. */
type Out<N extends OpName> = OpResult<N, FullOpInput<N>>;

/** A query bound to one op. */
export function useOpQuery<N extends OpName>(
  key: QueryKey,
  name: N,
  input: FullOpInput<N>,
  opts: QOpts<Out<N>> = {},
) {
  return useQuery<Out<N>, RpcError, Out<N>, QueryKey>({
    queryKey: key,
    queryFn: () => rpc(name, input),
    ...opts,
  });
}

/** A mutation bound to one op; `invalidate` lists keys to refetch after success. */
export function useOpMutation<N extends OpName>(
  name: N,
  opts: {
    invalidate?: (data: Out<N>, input: FullOpInput<N>) => QueryKey[];
    onSuccess?: (data: Out<N>, input: FullOpInput<N>, qc: QueryClient) => void;
  } = {},
) {
  const qc = useQueryClient();
  return useMutation<Out<N>, RpcError, FullOpInput<N>>({
    mutationFn: (input) => rpc(name, input),
    onSuccess: (data, input) => {
      opts.onSuccess?.(data, input, qc);
      for (const key of opts.invalidate?.(data, input) ?? [])
        void qc.invalidateQueries({ queryKey: key });
    },
  });
}

// ── reads ─────────────────────────────────────────────────────────

export const useCapabilities = () =>
  useQuery({ queryKey: qk.capabilities, queryFn: getCapabilities, staleTime: 5 * 60_000 });

/** Signed-in user, or null when signed out (401). */
export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        return await rpc('me.get', {});
      } catch (e) {
        if (e instanceof RpcError && e.code === 'unauthenticated') return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export const useTeams = () => useOpQuery(qk.teams, 'teams.list', {});
export const useTeam = (teamId: string | undefined) =>
  useOpQuery(qk.team(teamId ?? ''), 'teams.get', { teamId: teamId ?? '' }, { enabled: !!teamId });
export const useShows = () => useOpQuery(qk.shows, 'shows.list', {});
export const useShow = (showId: string | undefined) =>
  useOpQuery(qk.show(showId ?? ''), 'shows.get', { showId: showId ?? '' }, { enabled: !!showId });
export const useCategories = (showId: string | undefined) =>
  useOpQuery(
    qk.categories(showId ?? ''),
    'categories.list',
    { showId: showId ?? '' },
    { enabled: !!showId },
  );
export const useSessions = (showId: string | undefined) =>
  useOpQuery(
    qk.sessions(showId),
    'sessions.list',
    { showId, includeArchived: true, limit: 500 },
    { enabled: !!showId },
  );
export const useSession = (sessionId: string | undefined) =>
  useOpQuery(
    qk.session(sessionId ?? ''),
    'sessions.get',
    { sessionId: sessionId ?? '' },
    { enabled: !!sessionId },
  );
export const useEvents = (sessionId: string) =>
  useOpQuery(qk.events(sessionId), 'events.list', { sessionId });
export const useTranscript = (sessionId: string) =>
  useOpQuery(qk.transcript(sessionId), 'transcript.get', { sessionId });
export const useTopics = (sessionId: string) =>
  useOpQuery(qk.topics(sessionId), 'topics.list', { sessionId });
export const useDashboards = (sessionId: string) =>
  useOpQuery(qk.dashboards(sessionId), 'dashboards.list', { sessionId });
export const useDashboardQuery = (sessionId: string, query: DashboardQuery | undefined) =>
  useOpQuery(
    qk.dashboardQuery(sessionId, query ?? ({ name: 'summary_stats' } as DashboardQuery)),
    'dashboards.query',
    { sessionId, query: query ?? { name: 'summary_stats' } },
    { enabled: !!query },
  );
export const useMedia = (sessionId: string, enabled = true) =>
  useOpQuery(qk.media(sessionId), 'media.list', { sessionId }, { enabled, retry: false });
export const useJobs = (sessionId: string) =>
  useOpQuery(qk.jobs(sessionId), 'jobs.list', { sessionId }, { retry: false });
export const useChanges = (sessionId: string, via: Via | 'all') =>
  useOpQuery(qk.changes(sessionId, via), 'changes.list', {
    sessionId,
    ...(via === 'all' ? {} : { via }),
    grouped: true,
    limit: 300,
  });
/** Every page of a show's wiki (wiki.list is paged; the screens need all of it for links). */
export async function listAllWikiPages(showId: string, kind?: WikiKind, linksTo?: string) {
  const out: WikiListItem[] = [];
  for (let offset: number | null = 0; offset !== null; ) {
    const page: WikiList = await rpc('wiki.list', {
      showId,
      ...(kind ? { kind } : {}),
      ...(linksTo ? { linksTo } : {}),
      limit: 200,
      offset,
    });
    out.push(...page.pages);
    offset = page.nextOffset;
  }
  return out;
}
export const useWikiList = (showId: string | undefined, kind?: WikiKind) =>
  useQuery<WikiListItem[], RpcError>({
    queryKey: [...qk.wikiList(showId ?? ''), kind ?? 'all'],
    queryFn: () => listAllWikiPages(showId ?? '', kind),
    enabled: !!showId,
  });
/** Every page linking to a page (wiki.get lists only the first 50 backlinks), by title. */
export const useWikiBacklinks = (showId: string, pageId: string, enabled: boolean) =>
  useQuery<WikiListItem[], RpcError>({
    queryKey: [...qk.wikiList(showId), 'linksTo', pageId],
    queryFn: async () =>
      (await listAllWikiPages(showId, undefined, pageId)).sort((a, b) =>
        a.title.localeCompare(b.title),
      ),
    enabled,
  });
export const useWikiPage = (pageId: string | undefined) =>
  useOpQuery(
    qk.wikiPage(pageId ?? ''),
    'wiki.get',
    { pageId },
    { enabled: !!pageId, retry: false },
  );
export const useWikiRevisions = (pageId: string | undefined, enabled = true) =>
  useOpQuery(
    qk.wikiRevisions(pageId ?? ''),
    'wiki.revisions',
    { pageId: pageId ?? '' },
    { enabled: !!pageId && enabled },
  );
export const useSearch = (input: OpInput<'search'> | null) =>
  useOpQuery(qk.search(input ?? { query: '' }), 'search', input ?? { query: '' }, {
    enabled: !!input && input.query.trim().length >= 2,
    placeholderData: (prev) => prev,
  });
export const useTokens = () => useOpQuery(qk.tokens, 'tokens.list', {});
export const useCompanionDevices = () => useOpQuery(qk.companion, 'companion.list', {});
export const useAdminUsers = (enabled: boolean) =>
  useOpQuery(qk.adminUsers, 'admin.users', {}, { enabled });
