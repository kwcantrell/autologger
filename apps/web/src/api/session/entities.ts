// Where each session entity lives in the query cache, and what else depends on it. The only map
// from entity to cache keys: the live socket, op results and undo all read it.

import type {
  AudioSegment,
  ChangeEntity,
  DashboardQuery,
  Job,
  LiveEntity,
  SessionEvent,
} from '@autologger/contract';
import type { QueryKey } from '@tanstack/react-query';
import { qk } from '../queries';

type WithId = { id: string };

/** Keyed upsert into a cached list (a no-op while the list isn't loaded). */
/**
 * True when `next` is an older copy of the row than `cached`, by `updatedAt`. An op's HTTP result
 * and the socket's pushes are not ordered relative to each other, so a result can land after a
 * newer push (Start in the web as Companion stops) and must not overwrite it. Equal or missing
 * times count as not older, so a write that doesn't bump `updatedAt` still applies.
 */
export function isOlder(next: unknown, cached: unknown): boolean {
  const n = (next as { updatedAt?: unknown } | undefined)?.updatedAt;
  const c = (cached as { updatedAt?: unknown } | undefined)?.updatedAt;
  return typeof n === 'string' && typeof c === 'string' && Date.parse(n) < Date.parse(c);
}

export function upsertList<T extends WithId>(
  list: T[] | undefined,
  item: T,
  sort?: (a: T, b: T) => number,
): T[] | undefined {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === item.id);
  if (i !== -1 && isOlder(item, list[i])) return list;
  const next = i === -1 ? [...list, item] : list.map((x) => (x.id === item.id ? item : x));
  return sort ? next.sort(sort) : next;
}

export const removeFromList = <T extends WithId>(list: T[] | undefined, id: string) =>
  list?.filter((x) => x.id !== id);

export const byEventTime = (a: SessionEvent, b: SessionEvent) =>
  (a.timecodeFrames ?? Number.MAX_SAFE_INTEGER) - (b.timecodeFrames ?? Number.MAX_SAFE_INTEGER) ||
  a.wallTime.localeCompare(b.wallTime);
const byStart = (a: { startSec: number }, b: { startSec: number }) => a.startSec - b.startSec;
const byOrdinal = (a: AudioSegment, b: AudioSegment) => a.ordinal - b.ordinal;
const byNewest = (a: Job, b: Job) => b.createdAt.localeCompare(a.createdAt);

/** The dashboards' live queries of these names (see runDashboardQuery for what each reads). */
const dashboardQueries = (sid: string, ...names: DashboardQuery['name'][]): QueryKey[] =>
  names.map((n) => qk.dashboardQueryNamed(sid, n));

export interface EntitySpec {
  /** The cache entry holding this entity for a session. */
  key: (sessionId: string) => QueryKey;
  /**
   * How a single-row change is applied: `list` patches the cached list by id, `session` is the
   * session itself, `refetch` lists can't be patched (filtered per view) and are refetched.
   */
  apply: 'list' | 'session' | 'refetch';
  // biome-ignore lint/suspicious/noExplicitAny: one spec per entity; rows are typed at the use site
  sort?: (a: any, b: any) => number;
  /** Other entries derived from this entity, invalidated (by prefix) whenever it changes. */
  derived: (sessionId: string) => QueryKey[];
}

export const SESSION_ENTITIES: Record<LiveEntity, EntitySpec> = {
  session: {
    key: qk.session,
    apply: 'session',
    // Refetched on deletes and refetch hints; an upsert patches its row in them (cache.ts).
    derived: () => [qk.sessionsAll],
  },
  event: {
    key: qk.events,
    apply: 'list',
    sort: byEventTime,
    // Dashboards' live queries that count or list events. Not the sessions list (rail event
    // counts): the server follows every event write with the session (publishSession, or an
    // `invalidate session` on undo), which carries the new eventCount.
    derived: (sid) =>
      dashboardQueries(
        sid,
        'events_by_category',
        'events_over_time',
        'events',
        'category_count',
        'summary_stats',
      ),
  },
  topic: {
    key: qk.topics,
    apply: 'list',
    sort: byStart,
    derived: (sid) => dashboardQueries(sid, 'topics', 'summary_stats'),
  },
  transcript_segment: {
    key: qk.transcript,
    apply: 'list',
    sort: byStart,
    derived: (sid) => dashboardQueries(sid, 'speaker_talk_time', 'summary_stats'),
  },
  audio_segment: {
    key: qk.media,
    apply: 'list',
    sort: byOrdinal,
    // The session's audioSeconds is derived from its audio segments.
    derived: (sid) => [qk.session(sid), qk.sessionsAll],
  },
  dashboard: {
    key: qk.dashboards,
    apply: 'list',
    derived: () => [],
  },
  job: {
    key: qk.jobs,
    apply: 'list',
    sort: byNewest,
    // The session's transcriptJob; the show-wide job list (rail indicator).
    derived: (sid) => [qk.session(sid), qk.showJobsAll],
  },
  change: {
    key: qk.changesAll,
    apply: 'refetch',
    derived: () => [],
  },
};

const isLiveEntity = (e: string): e is LiveEntity => e in SESSION_ENTITIES;

/**
 * Every cache entry to refresh when `entity` changed in ways we can't patch (an undo, a bulk
 * rewrite): its own entry plus what derives from it. Entities with no session cache (wiki pages,
 * categories) have none.
 */
export function keysFor(entity: LiveEntity | ChangeEntity, sessionId: string): QueryKey[] {
  if (!isLiveEntity(entity)) return [];
  const spec = SESSION_ENTITIES[entity];
  return [spec.key(sessionId), ...spec.derived(sessionId)];
}

/** The session's lists (and the session itself), refreshed when the socket (re)opens. */
export const sessionKeys = (sessionId: string): QueryKey[] =>
  (Object.keys(SESSION_ENTITIES) as LiveEntity[])
    .filter((e) => SESSION_ENTITIES[e].apply !== 'refetch')
    .map((e) => SESSION_ENTITIES[e].key(sessionId));
