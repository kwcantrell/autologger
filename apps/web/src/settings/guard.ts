// Unsaved-changes registry for the Settings view's inline sections. Each section reports whether
// its draft differs from the saved state and how to throw it away; the view asks "Discard
// changes?" before a section switch or a close. Mounting a section reports nothing until dirty.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { SettingsSection } from '@/lib/store';

export interface SectionGuardState {
  dirty: boolean;
  discard?: () => void;
}

export interface SettingsNav {
  set: (id: SettingsSection, state: SectionGuardState | null) => void;
  /** Switch section, through the discard guard. */
  goTo: (id: SettingsSection) => void;
}

export const SettingsNavContext = createContext<SettingsNav | null>(null);

export function useSettingsNav() {
  return useContext(SettingsNavContext);
}

/** Report an inline section's dirtiness to the Settings view. */
export function useSectionGuard(id: SettingsSection, dirty: boolean, discard?: () => void) {
  const nav = useContext(SettingsNavContext);
  const discardRef = useRef(discard);
  discardRef.current = discard;
  useEffect(() => {
    if (!nav) return;
    nav.set(id, { dirty, discard: () => discardRef.current?.() });
    return () => nav.set(id, null);
  }, [nav, id, dirty]);
}

/**
 * An inline draft over a saved value. `key` identifies what is being edited (team id, show id);
 * when it changes, or the saved value changes while the draft is clean, the draft re-seeds.
 */
export function useInlineDraft<T>(key: string | null, saved: T | null) {
  const savedJson = saved === null ? null : JSON.stringify(saved);
  const [state, setState] = useState<{ key: string | null; base: string | null; value: T | null }>(
    () => ({
      key,
      base: savedJson,
      value: saved,
    }),
  );
  const dirty =
    state.value !== null && state.base !== null && JSON.stringify(state.value) !== state.base;
  if (state.key !== key || (!dirty && state.base !== savedJson)) {
    setState({ key, base: savedJson, value: saved });
  }
  const update = useCallback((patch: Partial<T>) => {
    setState((s) => (s.value === null ? s : { ...s, value: { ...s.value, ...patch } }));
  }, []);
  const discard = useCallback(() => {
    setState((s) => ({ ...s, value: s.base === null ? null : (JSON.parse(s.base) as T) }));
  }, []);
  /** After a save: the draft is the new baseline. */
  const markSaved = useCallback(() => {
    setState((s) => ({ ...s, base: s.value === null ? null : JSON.stringify(s.value) }));
  }, []);
  return { value: state.value, dirty, update, discard, markSaved };
}
