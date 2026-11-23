import { useCallback, useEffect, useRef, useState } from 'react';

// A change-log row's last Undo error ("This item changed again since; undo the newer change
// first."), shared by the session Agents tab and /changes. The error belongs to the list as it was
// when the undo failed: once the list changes (another undo, a live change, a refetch with new
// rows), the conflict may be gone, so every stale error is dropped. A refetch that returns the
// same rows keeps the same `data` reference (TanStack Query's structural sharing), so a failed
// undo's own refetch keeps its message.

interface RowErrorState<L> {
  list: L;
  errors: Readonly<Record<string, string>>;
}

const NONE: Readonly<Record<string, string>> = Object.freeze({});

/** The errors that still apply to `list`: none when they were recorded against another list. */
export function currentRowErrors<L>(state: RowErrorState<L>, list: L) {
  return state.list === list ? state.errors : NONE;
}

/** `state` with `id`'s error set (or cleared, for `undefined`), recorded against `list`. */
export function withRowError<L>(
  state: RowErrorState<L>,
  list: L,
  id: string,
  message: string | undefined,
): RowErrorState<L> {
  const { [id]: _, ...rest } = currentRowErrors(state, list);
  return { list, errors: message === undefined ? rest : { ...rest, [id]: message } };
}

/** Row errors for a change list (pass the query's `data`). `setRowError(id, undefined)` clears. */
export function useRowErrors<L>(list: L) {
  const [state, setState] = useState<RowErrorState<L>>({ list, errors: NONE });
  // The undo's callbacks run later: record against the list on screen then, not at click time.
  const latest = useRef(list);
  useEffect(() => {
    latest.current = list;
  }, [list]);
  const setRowError = useCallback(
    (id: string, message: string | undefined) =>
      setState((s) => withRowError(s, latest.current, id, message)),
    [],
  );
  return [currentRowErrors(state, list), setRowError] as const;
}
