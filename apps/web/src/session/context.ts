import type { Capabilities, Session } from '@autologger/contract';
import { createContext, useContext } from 'react';

export type WorkspaceTab = 'events' | 'transcript' | 'topics' | 'dashboards' | 'agents' | 'export';

export interface Workspace {
  session: Session;
  caps: Capabilities | undefined;
  /** The user may change this session's content. */
  canWrite: boolean;
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
