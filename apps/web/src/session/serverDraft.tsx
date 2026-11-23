// Inline editors over live data. A row's fields follow the server value (another tab, a teammate
// or an agent can change it at any time) until the user edits them; from then on the draft is
// theirs and remote changes no longer overwrite it. If the server value moved under the draft the
// field reports a conflict so the row can say "changed elsewhere". Saving or reverting the draft
// hands the field back to the server value.

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/shared/lib/utils';

export type DraftState = {
  /** What the input shows. */
  draft: string;
  /** The server value the draft started from; the draft is dirty when it differs. */
  base: string;
  /** After a save, the server value from before it: the field waits for the echo instead of
   * flashing back to it. */
  awaiting: string | null;
};

export const initialDraft = (server: string): DraftState => ({
  draft: server,
  base: server,
  awaiting: null,
});

/** The state after the server value became `server` (returns `st` itself when nothing changes). */
export function reconcile(st: DraftState, server: string): DraftState {
  if (server === st.base) return st.awaiting === null ? st : { ...st, awaiting: null };
  if (st.draft !== st.base) {
    // The user is editing: keep their draft. A remote change to the same text settles it.
    return server === st.draft ? initialDraft(server) : st;
  }
  // A save is on its way and the server still has the old value: wait for the echo.
  if (st.awaiting !== null && server === st.awaiting) return st;
  return initialDraft(server);
}

/** True when the user has unsaved edits and the server value changed under them. */
export const hasConflict = (st: DraftState, server: string) =>
  st.draft !== st.base && server !== st.base && server !== st.awaiting;

export type ServerDraft = {
  value: string;
  /** The current server value. */
  server: string;
  conflict: boolean;
  /** The user typed. */
  set: (v: string) => void;
  /** Drop the draft and show the server value again (Escape, invalid input, nothing changed). */
  reset: () => void;
  /** Save `value` with `send`; the field shows it until the server echoes it and resets to the
   * server value if `send` rejects (the caller reports why). */
  commit: (value: string, send: (value: string) => Promise<unknown>) => Promise<void>;
  /** For onBlur: true when the window lost focus (the field stays focused) while the draft is in
   * conflict. Skip the save then: switching windows doesn't decide the conflict for the user. */
  keepOnWindowBlur: (el: Element) => boolean;
};

export function useServerDraft(server: string): ServerDraft {
  const [stored, setStored] = useState(() => initialDraft(server));
  const st = reconcile(stored, server);
  // Adjusting state while rendering (React's pattern for state derived from props): no frame with
  // the stale value, and no effect that could overwrite a keystroke.
  if (st !== stored) setStored(st);
  const latest = useRef(server);
  useEffect(() => {
    latest.current = server;
  }, [server]);

  const conflict = hasConflict(st, server);
  return {
    value: st.draft,
    server,
    conflict,
    set: (v) => setStored((s) => ({ ...s, draft: v })),
    reset: () => setStored(initialDraft(latest.current)),
    commit: async (value, send) => {
      setStored({ draft: value, base: value, awaiting: server });
      try {
        await send(value);
      } catch {
        setStored(initialDraft(latest.current));
      }
    },
    keepOnWindowBlur: (el) => conflict && el.ownerDocument.activeElement === el,
  };
}

/** The subtle "changed elsewhere" note next to a field whose draft is in conflict. Clicking it
 * takes the remote value; it keeps focus in the field so the click doesn't save the draft first. */
export function ChangedElsewhere({
  remote,
  onTakeTheirs,
  className,
}: {
  /** The remote value(s), for the tooltip. */
  remote: string;
  onTakeTheirs: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className={cn(
        'shrink-0 whitespace-nowrap rounded-[3px] px-1 text-[0.65rem] text-(--si-accent-text) underline decoration-dotted underline-offset-2 hover:bg-[color-mix(in_oklab,var(--si-accent)_12%,transparent)]',
        className,
      )}
      title={`Changed elsewhere to “${remote}”. Saving keeps your text; Esc or click takes theirs.`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onTakeTheirs}
    >
      changed elsewhere
    </button>
  );
}
