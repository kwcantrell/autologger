// Tiny client-only stores (useSyncExternalStore). Server data lives in TanStack Query;
// these hold only UI state: the active team/show, the shell's transport tint, open overlays.

import { useSyncExternalStore } from 'react';

export function createStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next: T | ((prev: T) => T)) {
      const v = typeof next === 'function' ? (next as (p: T) => T)(value) : next;
      if (Object.is(v, value)) return;
      value = v;
      for (const s of subs) s();
    },
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export type Store<T> = ReturnType<typeof createStore<T>>;

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

const safeGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const safeSet = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

// ── active team / show (persisted per browser) ──────────────────────

export interface ActiveScope {
  teamId: string | null;
  showId: string | null;
}

export const activeScope = createStore<ActiveScope>({
  teamId: safeGet('al.activeTeam'),
  showId: safeGet('al.activeShow'),
});
activeScope.subscribe(() => {
  const v = activeScope.get();
  safeSet('al.activeTeam', v.teamId);
  safeSet('al.activeShow', v.showId);
});

// ── transport status published by the open workspace ────────────────

export type TransportTint = 'stopped' | 'rolling' | 'recording' | 'playback';
export const TRANSPORT_LABEL: Record<TransportTint, string> = {
  stopped: 'STOPPED',
  rolling: 'ROLLING',
  recording: 'REC',
  playback: 'PLAY',
};

export interface TransportStatus {
  state: TransportTint;
  sessionId: string | null;
  title: string | null;
}
export const transportStatus = createStore<TransportStatus>({
  state: 'stopped',
  sessionId: null,
  title: null,
});

// ── shell overlays ──────────────────────────────────────────────────

export type SettingsSection =
  | 'profile'
  | 'companion'
  | 'agents'
  | 'members'
  | 'shows'
  | 'team'
  | 'show-details'
  | 'event-buttons'
  | 'admin';

export const settingsOpen = createStore<SettingsSection | null>(null);
export const newSessionOpen = createStore<boolean>(false);
export const shortcutsOpen = createStore<boolean>(false);
export const paletteOpen = createStore<boolean>(false);
