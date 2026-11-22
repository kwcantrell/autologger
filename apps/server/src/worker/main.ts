// Worker entrypoint: `node src/worker/main.ts`. Runs background jobs from the `jobs` table
// (transcribe, youtube_import). Several workers may run side by side; claiming uses
// FOR UPDATE SKIP LOCKED.

import { eq } from 'drizzle-orm';
import { db, schema, sqlClient } from '../db/client.ts';
import { env, storageConfigured, transcriptionConfigured } from '../env.ts';
import { PermanentError } from '../media/deepgram.ts';
import { JOBS_CHANNEL, type JobRow } from '../media/jobs.ts';
import { ensureBucket } from '../media/s3.ts';
import { handlers } from './handlers.ts';
import { claimJob, completeJob, failJob, recoverStuckJobs, releaseJob } from './queue.ts';

const CONCURRENCY = env.workerConcurrency;
const POLL_MS = 5000;
const RECOVER_MS = 60_000;
const HEARTBEAT_MS = 60_000;

const active = new Map<string, Promise<void>>();
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

async function fillSlots(): Promise<void> {
  while (!stopping && active.size < CONCURRENCY) {
    const job = await claimJob();
    if (!job) return;
    const p = runJob(job).finally(() => {
      active.delete(job.id);
      wake?.();
    });
    active.set(job.id, p);
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
    Promise.allSettled(active.values()),
    new Promise((r) => setTimeout(r, 20_000)),
  ]);
  for (const id of ids) if (active.has(id)) await releaseJob(id).catch(() => {});
  await sqlClient.end({ timeout: 5 });
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown());

console.log(
  `autologger worker starting (concurrency ${CONCURRENCY}; storage ${storageConfigured ? 'on' : 'off'}, ` +
    `transcription ${transcriptionConfigured ? 'on' : 'off'}, youtube ${env.youtubeEnabled ? `on via ${env.ytDlpPath}` : 'off'})`,
);
await ensureBucket();
await sqlClient.listen(JOBS_CHANNEL, () => wake?.());
await loop();
