// Validation issues as `{ path, message }` with readable paths, shared by the server's error
// mapping and the web's local spec validation.

import type { z } from 'zod';

/** `['spec', 'widgets', 4, 'format']` → `spec.widgets[4].format`. */
export function issuePath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const p of path) {
    if (typeof p === 'number') out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out;
}

/** One entry per issue; an unknown-keys issue becomes one entry per key, its path ending in the key. */
export function formatIssues(
  issues: readonly z.core.$ZodIssue[],
): { path: string; message: string }[] {
  return issues.flatMap((i) =>
    i.code === 'unrecognized_keys'
      ? i.keys.map((k) => ({
          path: issuePath([...i.path, k]),
          message: `Unknown field "${k}" (not supported here; see the tool description).`,
        }))
      : [{ path: issuePath(i.path), message: i.message }],
  );
}
