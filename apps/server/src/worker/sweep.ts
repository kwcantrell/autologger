// Media sweep: storage the normal paths leave behind.
//
// - Uploads stuck in `uploading` (media.createUpload without media.completeUpload): the row and
//   any partial object.
// - `sessions/<id>/` prefixes whose session no longer exists, and `shows/<id>/` objects whose show
//   or compilation no longer exists. Deletes remove these after commit, best effort (#124); a
//   crash, an S3 outage or a job still uploading for a deleted session leaves them behind.
//
// Never touches objects of an existing session; under an existing show, only compilation MP4s
// whose compilation row is gone. Orphans are removed only when the newest object under them is
// older than the grace period, so an in-flight import or compile is not hit. Workers run it on an
// interval (src/worker/main.ts); a transaction-level advisory lock lets only one at a time sweep.

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { changeMessage, publish } from '../core/bus.ts';
import { db, schema } from '../db/client.ts';
import { env } from '../env.ts';
import { deleteObject, deletePrefix, listChildPrefixes, listObjects } from '../media/s3.ts';

const { audioSegments, compilations, sessions, shows } = schema;

const HOUR_MS = 3600_000;
/** Floor for both ages: a PUT URL lasts 15 minutes, imports and compiles well under an hour. */
const MIN_AGE_MS = HOUR_MS;
/** Ids checked against Postgres per query. */
const ID_BATCH = 500;

export interface SweepOptions {
  /** Uploads still `uploading` after this long are removed. */
  uploadAgeMs?: number;
  /** Orphan objects are removed only when the newest under their prefix is this old. */
  orphanGraceMs?: number;
  /** Log what would be removed; delete nothing. */
  dryRun?: boolean;
  now?: Date;
}

export interface SweepResult {
  /** False when another worker held the sweep lock. */
  ran: boolean;
  dryRun: boolean;
  /** Audio segment ids removed (or that would be, in a dry run). */
  uploads: string[];
  /** Whole prefixes removed: `sessions/<id>/` and `shows/<id>/` of deleted sessions and shows. */
  prefixes: string[];
  /** Single objects removed: compilation MP4s of deleted compilations under a live show. */
  objects: string[];
  /** Orphan prefixes and objects kept because something under them is newer than the grace. */
  withinGrace: number;
}

export async function sweepMedia(opts: SweepOptions = {}): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? env.mediaSweep.dryRun;
  const uploadAgeMs = Math.max(
    MIN_AGE_MS,
    opts.uploadAgeMs ?? env.mediaSweep.uploadAgeHours * HOUR_MS,
  );
  const graceMs = Math.max(
    MIN_AGE_MS,
    opts.orphanGraceMs ?? env.mediaSweep.orphanGraceHours * HOUR_MS,
  );
  const tag = dryRun ? 'media sweep (dry run): would remove' : 'media sweep: removed';
  const result: SweepResult = {
    ran: false,
    dryRun,
    uploads: [],
    prefixes: [],
    objects: [],
    withinGrace: 0,
  };
  const started = Date.now();
  const removed: { id: string; sessionId: string }[] = [];

  await db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ ok: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext('autologger:media-sweep')) as ok`,
    );
    if (!lock?.ok) return;
    result.ran = true;

    // 1. Abandoned uploads. Row locks keep a late media.completeUpload from racing the delete.
    const stuck = await tx
      .select({
        id: audioSegments.id,
        sessionId: audioSegments.sessionId,
        objectKey: audioSegments.objectKey,
      })
      .from(audioSegments)
      .where(
        and(
          eq(audioSegments.status, 'uploading'),
          lt(audioSegments.createdAt, new Date(now.getTime() - uploadAgeMs)),
        ),
      )
      .for('update', { skipLocked: true });
    for (const seg of stuck) {
      if (!dryRun) {
        try {
          await deleteObject(seg.objectKey);
        } catch (e) {
          console.warn(`media sweep: could not delete ${seg.objectKey}: ${(e as Error).message}`);
          continue; // keep the row so the next sweep retries
        }
        await tx.delete(audioSegments).where(eq(audioSegments.id, seg.id));
        removed.push(seg);
      }
      result.uploads.push(seg.id);
      console.log(`${tag} abandoned upload ${seg.id} (session ${seg.sessionId}, ${seg.objectKey})`);
    }

    const cutoff = now.getTime() - graceMs;
    const settled = async (prefix: string): Promise<{ old: boolean; count: number }> => {
      const objs = await listObjects(prefix);
      return {
        old: objs.length > 0 && objs.every((o) => o.lastModified.getTime() < cutoff),
        count: objs.length,
      };
    };
    const removePrefix = async (prefix: string, why: string): Promise<void> => {
      const { old, count } = await settled(prefix);
      if (!old) {
        if (count > 0) result.withinGrace++;
        return;
      }
      if (!dryRun) {
        try {
          await deletePrefix(prefix);
        } catch (e) {
          console.warn(`media sweep: could not delete ${prefix}: ${(e as Error).message}`);
          return;
        }
      }
      result.prefixes.push(prefix);
      console.log(`${tag} ${prefix} (${count} object(s); ${why})`);
    };

    // 2. Prefixes of sessions that no longer exist.
    for (const batch of chunks(idsUnder(await listChildPrefixes('sessions/')), ID_BATCH)) {
      const live = new Set(
        (
          await tx.select({ id: sessions.id }).from(sessions).where(inArray(sessions.id, batch))
        ).map((r) => r.id),
      );
      for (const id of batch)
        if (!live.has(id)) await removePrefix(`sessions/${id}/`, 'session no longer exists');
    }

    // 3. Show prefixes: the whole prefix of a deleted show; under a live show, compilation
    //    MP4s whose compilation was deleted. Any other key shape under a live show is kept.
    for (const batch of chunks(idsUnder(await listChildPrefixes('shows/')), ID_BATCH)) {
      const live = new Set(
        (await tx.select({ id: shows.id }).from(shows).where(inArray(shows.id, batch))).map(
          (r) => r.id,
        ),
      );
      for (const showId of batch) {
        if (!live.has(showId)) {
          await removePrefix(`shows/${showId}/`, 'show no longer exists');
          continue;
        }
        const dir = `shows/${showId}/compilations/`;
        const objs = await listObjects(dir);
        const byId = new Map<string, { key: string; lastModified: Date }>();
        for (const o of objs) {
          const m = o.key.slice(dir.length).match(/^([^/]+)\.mp4$/);
          if (m) byId.set(m[1]!, o);
        }
        if (byId.size === 0) continue;
        const kept = new Set(
          (
            await tx
              .select({ id: compilations.id })
              .from(compilations)
              .where(
                and(eq(compilations.showId, showId), inArray(compilations.id, [...byId.keys()])),
              )
          ).map((r) => r.id),
        );
        for (const [id, o] of byId) {
          if (kept.has(id)) continue;
          if (o.lastModified.getTime() >= cutoff) {
            result.withinGrace++;
            continue;
          }
          if (!dryRun) {
            try {
              await deleteObject(o.key);
            } catch (e) {
              console.warn(`media sweep: could not delete ${o.key}: ${(e as Error).message}`);
              continue;
            }
          }
          result.objects.push(o.key);
          console.log(`${tag} ${o.key} (compilation no longer exists)`);
        }
      }
    }
  });

  console.log(summaryLine(result, Date.now() - started));
  for (const seg of removed)
    publish(`session:${seg.sessionId}`, changeMessage('audio_segment', 'delete', seg.id));
  return result;
}

/**
 * One line per run, so an operator can tell the sweep ran even when it found nothing:
 * `media sweep (dry run): 0 stuck uploads, 1 orphan prefix, 0 compilation objects would be
 * removed; 1 orphan within grace; 12 s`.
 */
export function summaryLine(r: SweepResult, elapsedMs: number): string {
  const head = r.dryRun ? 'media sweep (dry run)' : 'media sweep';
  if (!r.ran) return `${head}: skipped, another worker holds the sweep lock`;
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return `${head}: ${[
    n(r.uploads.length, 'stuck upload', 'stuck uploads'),
    n(r.prefixes.length, 'orphan prefix', 'orphan prefixes'),
    n(r.objects.length, 'compilation object', 'compilation objects'),
  ].join(', ')} ${r.dryRun ? 'would be removed' : 'removed'}; ${n(
    r.withinGrace,
    'orphan',
    'orphans',
  )} within grace; ${Math.round(elapsedMs / 1000)} s`;
}

/** `sessions/<id>/` → `<id>`; anything not shaped like an id folder is ignored. */
function idsUnder(prefixes: string[]): string[] {
  return prefixes.flatMap((p) => {
    const id = p.split('/')[1];
    return id ? [id] : [];
  });
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
