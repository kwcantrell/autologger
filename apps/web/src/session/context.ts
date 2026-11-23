import type { Capabilities, Session } from '@autologger/contract';
import { createContext, useContext } from 'react';
import { type Store, useStore } from '@/lib/store';
import type { TransportClock } from '@/lib/timecode';
import type { Player } from './audio/usePlayer';

export type WorkspaceTab = 'events' | 'transcript' | 'topics' | 'dashboards' | 'agents' | 'export';

export interface Workspace {
  session: Session;
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
 * Session second under the playhead: the clock while rolling, else the player position (or the
 * clock when nothing was played yet). Re-renders the caller each frame while rolling or playing.
 */
export function usePlayheadSec(): number {
  const { session, clock, player } = useWorkspace();
  const c = useStore(clock);
  const pos = useStore(player.position);
  return session.isRolling ? c.elapsedSec : (pos ?? c.elapsedSec);
}
