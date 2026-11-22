// Worker entrypoint: `node src/worker/main.ts`. Runs background jobs from the `jobs` table
// (transcribe, youtube_import). Several workers may run side by side; claiming uses
// FOR UPDATE SKIP LOCKED.

import { eq } from 'drizzle-orm';
import { newId } from '../core/ids.ts';
import { db, schema, sqlClient } from '../db/client.ts';
import { waitForMigrations } from '../db/migrate.ts';
import { env, storageConfigured, transcriptionConfigured } from '../env.ts';
import { PermanentError } from '../media/deepgram.ts';
import { JOBS_CHANNEL, type JobRow, WORKER_HEARTBEAT_SEC } from '../media/jobs.ts';
import { ensureBucket } from '../media/s3.ts';
import { handlers } from './handlers.ts';
import {
  beatWorker,
  claimJob,
  completeJob,
  failJob,
  recoverStuckJobs,
  releaseJob,
  removeWorker,
} from './queue.ts';

const CONCURRENCY = env.workerConcurrency;
const POLL_MS = 5000;
const RECOVER_MS = 60_000;
const HEARTBEAT_MS = 60_000;

const KIND_CONCURRENCY = env.workerKindConcurrency;
const WORKER_ID = newId('wrk');

// Heartbeat row in `workers`: tells the API how many job slots are live (jobs.list etaSec).
const beat = () =>
  beatWorker(WORKER_ID, CONCURRENCY, KIND_CONCURRENCY).catch((e) =>
    console.error('worker heartbeat failed', e),
  );
let presence: ReturnType<typeof setInterval> | undefined;

const active = new Map<string, { kind: JobRow['kind']; done: Promise<void> }>();
let stopping = false;
let wake: (() => void) | null = null;

async function runJob(job: JobRow): Promise<void> {
  const handler = handlers[job.kind];
  const heartbeat = setInterval(() => {
    db.update(schema.jobs)
      .set({ lockedAt: new Date() })
      .where(eq(schema.jobs.id, job.id))
      .catch(() => {});
  }, HEARTBEAT_MS);
  try {
    if (!handler) throw new PermanentError(`Unknown job kind ${job.kind}.`);
    const note = await handler.run(job);
    await completeJob(job, note || 'Done');
    console.log(`job ${job.id} (${job.kind}) done${note ? `: ${note}` : ''}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const retry = await failJob(job, message, e instanceof PermanentError).catch((err) => {
      console.error('could not record job failure', err);
      return false;
    });
    console.warn(
      `job ${job.id} (${job.kind}) attempt ${job.attempts} failed${retry ? ', will retry' : ''}: ${message}`,
    );
    if (!retry) await handler?.onFinalFailure?.(job, message).catch((err) => console.error(err));
  } finally {
    clearInterval(heartbeat);
  }
}

/** Kinds that already fill their WORKER_CONCURRENCY_<KIND> slots in this worker. */
function fullKinds(): JobRow['kind'][] {
  const running = new Map<JobRow['kind'], number>();
  for (const { kind } of active.values()) running.set(kind, (running.get(kind) ?? 0) + 1);
  return (Object.keys(KIND_CONCURRENCY) as JobRow['kind'][]).filter(
    (kind) => (running.get(kind) ?? 0) >= KIND_CONCURRENCY[kind],
  );
}

async function fillSlots(): Promise<void> {
  while (!stopping && active.size < CONCURRENCY) {
    const job = await claimJob(fullKinds());
    if (!job) return;
    const done = runJob(job).finally(() => {
      active.delete(job.id);
      wake?.();
    });
    active.set(job.id, { kind: job.kind, done });
  }
}

async function recover(): Promise<void> {
  try {
    for (const job of await recoverStuckJobs()) {
      await handlers[job.kind]?.onFinalFailure?.(
        job,
        job.error ?? 'The worker stopped while running this job.',
      );
    }
  } catch (e) {
    console.error('recovering stuck jobs failed', e);
  }
}

async function loop(): Promise<void> {
  let lastRecover = 0;
  while (!stopping) {
    if (Date.now() - lastRecover > RECOVER_MS) {
      lastRecover = Date.now();
      await recover();
    }
    try {
      await fillSlots();
    } catch (e) {
      console.error('claiming jobs failed', e);
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, POLL_MS);
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  wake?.();
  console.log(`worker stopping; waiting for ${active.size} job(s)`);
  const ids = [...active.keys()];
  await Promise.race([
    Promise.allSettled([...active.values()].map((a) => a.done)),
    new Promise((r) => setTimeout(r, 20_000)),
  ]);
  for (const id of ids) if (active.has(id)) await releaseJob(id).catch(() => {});
  clearInterval(presence);
  await removeWorker(WORKER_ID).catch(() => {});
  await sqlClient.end({ timeout: 5 });
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown());

console.log(
  `autologger worker starting (concurrency ${CONCURRENCY}, per kind ${JSON.stringify(KIND_CONCURRENCY)}; storage ${storageConfigured ? 'on' : 'off'}, ` +
    `transcription ${transcriptionConfigured ? 'on' : 'off'}, youtube ${env.youtubeEnabled ? `on via ${env.ytDlpPath}` : 'off'})`,
);
// The API applies migrations; claiming or beating first can hit a missing table or column.
await waitForMigrations();
await ensureBucket();
await beat();
presence = setInterval(beat, WORKER_HEARTBEAT_SEC * 1000);
await sqlClient.listen(JOBS_CHANNEL, () => wake?.());
await loop();
