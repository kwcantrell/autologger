// Pushes that land while a list is being fetched. The response may have been read before them, so
// it would overwrite them when it lands: each fetch keeps a journal of the patches applied to its
// key meanwhile and replays them onto the fetched data. No push is lost, and none causes another
// fetch.

import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query';

type Patch<T> = (data: T) => T;

interface Recording {
  // biome-ignore lint/suspicious/noExplicitAny: patches are typed by the list they target
  patches: Patch<any>[];
  /** Patches already replayed onto the fetched data (set when the fetch returns). */
  replayed: number | null;
}

/** Recordings by query hash, oldest fetch first, per QueryClient. */
const journals = new WeakMap<QueryClient, Map<string, Recording[]>>();

/** Past this many patches during one fetch, stop recording and refetch once instead. */
const MAX_PATCHES = 500;

function journalOf(qc: QueryClient): Map<string, Recording[]> {
  let j = journals.get(qc);
  if (j) return j;
  j = new Map();
  journals.set(qc, j);
  const byHash = j;
  // A fetch's data is stored a few microtasks after its queryFn returns. Patches recorded in that
  // gap missed the replay: apply them once the data is stored. Older recordings for the same key
  // belong to superseded fetches and are dropped.
  qc.getQueryCache().subscribe((e) => {
    if (e.type !== 'updated' || e.action.type !== 'success' || e.action.manual) return;
    const recs = byHash.get(e.query.queryHash);
    if (!recs) return;
    let done = -1;
    for (let i = recs.length - 1; i >= 0; i--)
      if (recs[i]?.replayed !== null) {
        done = i;
        break;
      }
    if (done === -1) return;
    const rec = recs[done] as Recording;
    const late = rec.patches.slice(rec.replayed ?? 0);
    recs.splice(0, done + 1);
    if (!recs.length) byHash.delete(e.query.queryHash);
    if (late.length)
      e.query.setData(
        late.reduce((d, p) => p(d), e.query.state.data),
        { manual: true },
      );
  });
  return j;
}

/**
 * Wrap a list fetch so patches applied to `key` while it runs are replayed onto its result.
 * Use as the queryFn of every session list that receives live patches.
 */
export async function journaledFetch<T>(
  qc: QueryClient,
  key: QueryKey,
  fetch: () => Promise<T>,
): Promise<T> {
  const j = journalOf(qc);
  const hash = hashKey(key);
  const rec: Recording = { patches: [], replayed: null };
  j.set(hash, [...(j.get(hash) ?? []), rec]);
  let data: T;
  try {
    data = await fetch();
  } catch (err) {
    drop(j, hash, rec);
    throw err;
  }
  if (rec.patches.length > MAX_PATCHES) {
    // Too much happened while fetching: replaying is no cheaper than reading again.
    drop(j, hash, rec);
    queueMicrotask(() => void qc.invalidateQueries({ queryKey: key, exact: true }));
    return data;
  }
  rec.replayed = rec.patches.length;
  return rec.patches.reduce((d, p) => p(d), data);
}

function drop(j: Map<string, Recording[]>, hash: string, rec: Recording) {
  const recs = j.get(hash)?.filter((r) => r !== rec);
  if (recs?.length) j.set(hash, recs);
  else j.delete(hash);
}

/** Record a patch applied to `key` for every fetch of it in flight (or not yet stored). */
export function recordPatch<T>(qc: QueryClient, key: QueryKey, patch: Patch<T>) {
  const recs = journals.get(qc)?.get(hashKey(key));
  if (!recs) return;
  for (const rec of recs) if (rec.patches.length <= MAX_PATCHES) rec.patches.push(patch);
}
