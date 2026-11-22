// Show-wide background jobs (YouTube imports, transcriptions): the rail indicator, the per-card
// status mark and the dialog listing every unfinished job and every failure nobody has dismissed,
// with a retry for failed YouTube imports and a dismiss for each failure.

import type { Job, Session } from '@autologger/contract';
import { CheckIcon, Loader2Icon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { qk, useOpMutation } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import type { ShowJobs } from '@/api/showJobs';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Spinner } from '@/shared/components/ui/spinner';
import { cn } from '@/shared/lib/utils';
import { Dialog } from '@/shared/ui/Dialog';

const KIND_LABEL: Record<string, string> = {
  youtube_import: 'YouTube import',
  transcribe: 'Transcription',
};
const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "about 4 min left" from a jobs.list etaSec (a rough estimate; 0 = overdue). */
function fmtEta(sec: number | undefined): string | null {
  if (sec === undefined) return null;
  if (sec <= 0) return 'taking longer than usual';
  if (sec < 60) return 'under a minute left';
  const min = Math.round(sec / 60);
  if (min < 60) return `about ${min} min left`;
  return `about ${Math.floor(min / 60)} h ${min % 60} min left`;
}

function markLabel(j: Job): string {
  if (j.status === 'failed') return 'Failed';
  if (j.status === 'queued') return 'Queued';
  return j.kind === 'youtube_import' ? 'Importing' : 'Transcribing';
}

/** Short status for a rail session card, with the details in a tooltip. */
export function JobMark({ job }: { job: Job }) {
  const detail =
    job.status === 'failed'
      ? `${kindLabel(job.kind)} failed: ${job.error ?? 'no reason given'}`
      : `${kindLabel(job.kind)}: ${job.progress ?? job.status}${
          fmtEta(job.etaSec) ? ` (${fmtEta(job.etaSec)})` : ''
        }`;
  return (
    <Badge
      variant={job.status === 'failed' ? 'destructive' : 'outline'}
      className={cn(
        'px-1 py-px text-[0.625rem] leading-none',
        job.status === 'running' && 'text-foreground',
      )}
      title={detail}
      // Short on purpose: it joins the session card's accessible name (details are in the title).
      aria-label={`${markLabel(job)}: ${kindLabel(job.kind)}`}
    >
      {markLabel(job)}
    </Badge>
  );
}

export function JobsIcon({ data }: { data: ShowJobs | undefined }) {
  return data?.active.length ? (
    <Loader2Icon aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
  ) : (
    <TriangleAlertIcon aria-hidden="true" className="text-si-danger" />
  );
}

export function ShowJobsDialog({
  showName,
  data,
  error,
  sessions,
  onOpenSession,
  onClose,
}: {
  showName: string;
  data: ShowJobs | undefined;
  error: unknown;
  sessions: Session[];
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
}) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const retry = useOpMutation('media.importYoutube', {
    invalidate: () => [qk.showJobsAll],
    onSuccess: () => showToast('Import queued again.'),
  });
  const [retried, setRetried] = useState<Set<string>>(() => new Set());
  const dismiss = useOpMutation('jobs.dismiss', {
    invalidate: () => [qk.showJobsAll],
    onSuccess: () => showToast('Failure dismissed.'),
  });
  const running = (data?.active ?? []).filter((j) => j.status === 'running');
  const queued = (data?.active ?? [])
    .filter((j) => j.status === 'queued')
    .sort(
      (a, b) =>
        (a.queuePosition ?? Number.MAX_SAFE_INTEGER) -
          (b.queuePosition ?? Number.MAX_SAFE_INTEGER) || a.createdAt.localeCompare(b.createdAt),
    );
  const failed = data?.failed ?? [];
  const empty = data && !running.length && !queued.length && !failed.length;

  const row = (j: Job, status: React.ReactNode, action?: React.ReactNode) => {
    const s = j.sessionId ? byId.get(j.sessionId) : undefined;
    const title = s?.title || j.sessionTitle || 'Untitled session';
    return (
      <li
        key={j.id}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-ctl border border-si-line px-3 py-2 text-sm"
      >
        <span className="flex min-w-0 flex-1 basis-48 flex-col">
          {j.sessionId ? (
            <button
              type="button"
              className="min-w-0 cursor-pointer truncate text-left font-semibold hover:underline focus-visible:underline"
              onClick={() => onOpenSession(j.sessionId as string)}
            >
              {title}
            </button>
          ) : (
            <span className="truncate font-semibold">{title}</span>
          )}
          <span className="text-xs text-muted-foreground">
            {kindLabel(j.kind)}
            {status}
          </span>
        </span>
        {action}
      </li>
    );
  };

  const section = (label: string, jobs: Job[], render: (j: Job) => React.ReactNode) =>
    jobs.length > 0 && (
      <section className="flex flex-col gap-1.5">
        <h3 className="m-0 font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim">
          {label} ({jobs.length})
        </h3>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{jobs.map(render)}</ul>
      </section>
    );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Background jobs"
      description={`YouTube imports and transcriptions in ${showName}. Failures stay listed until they are retried or dismissed.`}
      className="md:max-w-xl"
    >
      <div className="flex max-h-[60svh] flex-col gap-4 overflow-y-auto pr-1">
        {error ? (
          <p className="m-0 text-sm text-si-danger">
            Couldn't load background jobs. {errorMessage(error)}
          </p>
        ) : !data ? (
          <div className="flex justify-center py-2">
            <Spinner />
          </div>
        ) : null}
        {empty && (
          <p className="m-0 text-sm text-si-muted">
            Nothing running in this show. Imports and transcriptions appear here while they run.
          </p>
        )}
        {section('Failed', failed, (j) => {
          const s = j.sessionId ? byId.get(j.sessionId) : undefined;
          const canRetry = j.kind === 'youtube_import' && !!s?.sourceUrl && s.access !== 'read';
          const pending = retry.isPending && retry.variables?.sessionId === j.sessionId;
          const readOnly = s?.access === 'read';
          const dismissing = dismiss.isPending && dismiss.variables?.jobId === j.id;
          const retryAction =
            j.kind === 'youtube_import' && s?.sourceUrl ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canRetry || pending || retried.has(j.id)}
                title={
                  s.access === 'read'
                    ? 'Read-only access to this show.'
                    : `Download ${s.sourceUrl} again`
                }
                onClick={() =>
                  retry.mutate(
                    { sessionId: s.id, url: s.sourceUrl as string },
                    {
                      onSuccess: () => setRetried((r) => new Set(r).add(j.id)),
                      onError: (e) => showToast(errorMessage(e), true),
                    },
                  )
                }
              >
                <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
                {pending ? 'Retrying…' : 'Retry'}
              </Button>
            ) : null;
          return row(
            j,
            <span className="block text-si-danger [overflow-wrap:anywhere]">
              {j.error ?? 'Failed without a reason.'}
            </span>,
            <>
              {retryAction}
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly || dismissing}
                title={
                  readOnly
                    ? 'Read-only access to this show.'
                    : 'Acknowledge this failure and stop listing it'
                }
                onClick={() =>
                  dismiss.mutate(
                    { jobId: j.id },
                    { onError: (e) => showToast(errorMessage(e), true) },
                  )
                }
              >
                <CheckIcon aria-hidden="true" data-icon="inline-start" />
                {dismissing ? 'Dismissing…' : 'Dismiss'}
              </Button>
              {j.kind === 'youtube_import' && !s?.sourceUrl && (
                <span className="basis-full text-xs text-muted-foreground">
                  The link isn't stored on this session: open it and import the video again from its
                  Audio menu.
                </span>
              )}
            </>,
          );
        })}
        {section('Running', running, (j) => {
          const eta = fmtEta(j.etaSec);
          return row(
            j,
            <>
              {` · ${j.progress ?? 'Running'}`}
              {eta && ` · ${eta}`}
            </>,
          );
        })}
        {section('Queued', queued, (j) => {
          const eta = fmtEta(j.etaSec);
          return row(
            j,
            <>
              {j.queuePosition !== undefined
                ? ` · ${j.queuePosition === 0 ? 'next in line' : `${plural(j.queuePosition, 'job')} ahead`}`
                : j.error
                  ? ` · waiting to retry: ${j.error}`
                  : ' · waiting'}
              {eta && ` · ${eta}`}
            </>,
          );
        })}
      </div>
    </Dialog>
  );
}
