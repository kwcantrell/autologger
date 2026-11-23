import type { Capabilities, SessionDetail } from '@autologger/contract';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import { sessionQuery } from '@/api/queries';
import type { Store } from '@/lib/store';
import type { TransportClock } from '@/lib/timecode';
import type { Player } from './audio/usePlayer';

export type WorkspaceTab = 'events' | 'transcript' | 'topics' | 'dashboards' | 'agents' | 'export';

/**
 * What the session workspace shares with everything under it. It holds no session data (read it
 * with `useSessionSlice`), so a session push doesn't re-render every consumer.
 */
export interface Workspace {
  sessionId: string;
  showId: string;
  caps: Capabilities | undefined;
  /** The user may change this session's content. */
  canWrite: boolean;
  /** Live transport clock; read it with `useStore` only where it is drawn (it ticks each frame). */
  clock: Store<TransportClock>;
  /** Session audio player; `player.position` ticks each frame while playing. */
  player: Player;
  /** Seek the session audio to session seconds (and play when `play`). */
  seek: (sec: number, play?: boolean) => void;
  /** Switch the workspace tab. */
  setTab: (tab: WorkspaceTab) => void;
  /** Reveal and flash an event row in the Event Feed. */
  revealEvent: (eventId: string) => void;
}

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error('useWorkspace outside a session workspace');
  return ws;
}

/**
 * The fields of the open session that the caller reads, re-rendering it only when they change
 * (structural sharing keeps an unchanged slice the same object). Select only what you use.
 */
export function useSessionSlice<T>(select: (s: SessionDetail) => T): T {
  const { sessionId } = useWorkspace();
  // The workspace only renders once the session is loaded, so `data` is there.
  return useQuery({ ...sessionQuery(sessionId), select }).data as T;
}

/** A value that changes faster than React should render: read it, or subscribe to changes. */
export interface Source<T> {
  get: () => T;
  subscribe: (onChange: () => void) => () => void;
}

/**
 * Session second under the playhead: the clock while rolling, else the player position (or the
 * clock when nothing was played yet). Changes every frame while rolling or playing, so read it
 * in event handlers and effects, or through `usePlayhead` with a coarse selector.
 */
export function usePlayheadSource(): Source<number> {
  const { clock, player } = useWorkspace();
  const rolling = useSessionSlice((s) => s.isRolling);
  const position = player.position;
  return useMemo(
    () => ({
      get: () => {
        const c = clock.get().elapsedSec;
        return rolling ? c : (position.get() ?? c);
      },
      subscribe: (onChange) => {
        const a = clock.subscribe(onChange);
        const b = position.subscribe(onChange);
        return () => {
          a();
          b();
        };
      },
    }),
    [rolling, clock, position],
  );
}

/**
 * `select(playheadSec)`, re-rendering the caller only when the selected value changes. Select
 * something coarse (a row index, whole seconds, a pixel column): selecting the raw second
 * re-renders every frame.
 */
export function usePlayhead<T>(select: (sec: number) => T): T {
  const source = usePlayheadSource();
  return useSyncExternalStore(source.subscribe, () => select(source.get()));
}

/** Index of the last of `starts` (ascending) at or before `sec`, or -1. */
export function indexAt(starts: readonly number[], sec: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] as number) <= sec) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
