// Show-wide background jobs (YouTube imports, transcriptions, video compilations): the rail
// indicator, the per-card status mark and the dialog listing every unfinished job and every
// failure nobody has dismissed, with a retry for failed YouTube imports, transcriptions,
// waveforms and compilations and a dismiss for each failure. Compile jobs belong to the show, not a session: they
// link to the Compilations page.

import type { Job, Session } from '@autologger/contract';
import { CheckIcon, Loader2Icon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { qk, useCapabilities, useOpMutation, useRetryCompilation } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import type { ShowJobs } from '@/api/showJobs';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Spinner } from '@/shared/components/ui/spinner';
import { cn } from '@/shared/lib/utils';
import { Dialog } from '@/shared/ui/Dialog';
import { isYoutubeAuthError, YoutubeAuthHelp } from './YoutubeAuthHelp';

const KIND_LABEL: Record<string, string> = {
  youtube_import: 'YouTube import',
  transcribe: 'Transcription',
  waveform: 'Waveform',
  compile: 'Video compilation',
};
const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "about 4 min left" from a jobs.list etaSec (a rough estimate; 0 = overdue). */
export function fmtEta(sec: number | undefined): string | null {
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
  if (j.kind === 'waveform') return 'Analyzing';
  if (j.kind === 'compile') return 'Compiling';
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
  canWriteShow,
  onOpenSession,
  onOpenCompilations,
  onOpenSettings,
  onClose,
}: {
  showName: string;
  data: ShowJobs | undefined;
  error: unknown;
  sessions: Session[];
  /** Write access to the show (dismissing a show-level compile job). */
  canWriteShow: boolean;
  onOpenSession: (sessionId: string) => void;
  onOpenCompilations: () => void;
  /** Before a failure's help link opens Settings: close this dialog (and the phone rail). */
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const retry = useOpMutation('media.importYoutube', {
    invalidate: () => [qk.showJobsAll],
    onSuccess: () => showToast('Import queued again.'),
  });
  const rewave = useOpMutation('media.rewaveform', {
    invalidate: () => [qk.showJobsAll],
    onSuccess: () => showToast('Waveform queued again.'),
  });
  const retranscribe = useOpMutation('media.retranscribe', {
    invalidate: () => [qk.showJobsAll],
    onSuccess: () => showToast('Transcription queued again.'),
  });
  const recompile = useRetryCompilation();
  const transcription = useCapabilities().data?.transcription;
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
    const title =
      j.kind === 'compile'
        ? j.compilationTitle || 'Deleted compilation'
        : s?.title || j.sessionTitle || 'Untitled session';
    return (
      <li
        key={j.id}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-ctl border border-si-line px-3 py-2 text-sm"
      >
        <span className="flex min-w-0 flex-1 basis-48 flex-col">
          {j.sessionId ? (
            <Button
              variant="link"
              size="inline"
              className="min-w-0 truncate font-semibold no-underline hover:underline focus-visible:underline"
              onClick={() => onOpenSession(j.sessionId as string)}
            >
              {title}
            </Button>
          ) : j.kind === 'compile' && j.compilationTitle ? (
            <Button
              variant="link"
              size="inline"
              className="min-w-0 truncate font-semibold no-underline hover:underline focus-visible:underline"
              title="Open the Compilations page"
              onClick={onOpenCompilations}
            >
              {title}
            </Button>
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
      description={`YouTube imports, transcriptions and video compilations in ${showName}. Failures stay listed until they are retried or dismissed.`}
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
            Nothing running in this show. Imports, transcriptions and compilations appear here while
            they run.
          </p>
        )}
        {section('Failed', failed, (j) => {
          const s = j.sessionId ? byId.get(j.sessionId) : undefined;
          const importUrl = j.sourceUrl ?? s?.sourceUrl ?? null;
          const canRetry = j.kind === 'youtube_import' && !!importUrl && s?.access !== 'read';
          const pending = retry.isPending && retry.variables?.sessionId === j.sessionId;
          const readOnly = j.sessionId ? s?.access === 'read' : !canWriteShow;
          const dismissing = dismiss.isPending && dismiss.variables?.jobId === j.id;
          const rewaving = rewave.isPending && rewave.variables?.sessionId === j.sessionId;
          const transcribing =
            retranscribe.isPending && retranscribe.variables?.segmentId === j.segmentId;
          const recompiling =
            recompile.isPending && recompile.variables?.compilationId === j.compilationId;
          const retryAction =
            j.kind === 'transcribe' && j.segmentId && s ? (
              <Button
                size="sm"
                variant="outline"
                disabled={readOnly || !transcription || transcribing || retried.has(j.id)}
                title={
                  readOnly
                    ? 'Read-only access to this show.'
                    : transcription === false
                      ? "Transcription isn't configured on this server."
                      : 'Transcribe this audio segment again (only this segment)'
                }
                onClick={() =>
                  retranscribe.mutate(
                    { sessionId: s.id, segmentId: j.segmentId },
                    {
                      onSuccess: () => setRetried((r) => new Set(r).add(j.id)),
                      onError: (e) => showToast(errorMessage(e), true),
                    },
                  )
                }
              >
                <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
                {transcribing ? 'Queuing…' : 'Transcribe again'}
              </Button>
            ) : j.kind === 'waveform' && s ? (
              <Button
                size="sm"
                variant="outline"
                disabled={readOnly || rewaving || retried.has(j.id)}
                title={
                  readOnly
                    ? 'Read-only access to this show.'
                    : j.segmentId
                      ? 'Compute the waveform of this audio segment again'
                      : "Compute the waveform of this session's audio again"
                }
                onClick={() =>
                  rewave.mutate(
                    { sessionId: s.id, segmentId: j.segmentId },
                    {
                      onSuccess: () => setRetried((r) => new Set(r).add(j.id)),
                      onError: (e) => showToast(errorMessage(e), true),
                    },
                  )
                }
              >
                <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
                {rewaving ? 'Retrying…' : 'Retry'}
              </Button>
            ) : j.kind === 'compile' && j.compilationId && j.compilationTitle ? (
              <Button
                size="sm"
                variant="outline"
                disabled={readOnly || recompiling || retried.has(j.id)}
                title={readOnly ? 'Read-only access to this show.' : 'Build this compilation again'}
                onClick={() =>
                  recompile.mutate(
                    { compilationId: j.compilationId as string },
                    {
                      onSuccess: () => {
                        setRetried((r) => new Set(r).add(j.id));
                        showToast('Compilation queued again.');
                      },
                      onError: (e) => showToast(errorMessage(e), true),
                    },
                  )
                }
              >
                <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
                {recompiling ? 'Retrying…' : 'Retry'}
              </Button>
            ) : j.kind === 'youtube_import' && s && importUrl ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canRetry || pending || retried.has(j.id)}
                title={
                  s.access === 'read'
                    ? 'Read-only access to this show.'
                    : `Download ${importUrl} again`
                }
                onClick={() =>
                  retry.mutate(
                    { sessionId: s.id, url: importUrl },
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
            <>
              <span className="block text-si-danger [overflow-wrap:anywhere]">
                {j.error ?? 'Failed without a reason.'}
              </span>
              {isYoutubeAuthError(j.error) && <YoutubeAuthHelp onNavigate={onOpenSettings} />}
            </>,
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
              {j.kind === 'youtube_import' && !importUrl && (
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
