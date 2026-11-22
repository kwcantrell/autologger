// `/compilations`: video compilations of the active show. Agents create them over MCP
// (compilations.create) from ranges of YouTube-imported sessions; the worker builds one MP4 each.
// Here people watch, download and delete them. Updates arrive as show-socket hints (liveShow.ts).

import type { Compilation } from '@autologger/contract';
import { DownloadIcon, Trash2Icon } from 'lucide-react';
import { Link } from 'wouter';
import { useCapabilities, useCompilations, useDeleteCompilation } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { PageFrame, RouteLoadingState } from '@/components/RouteState';
import { fmtShort } from '@/lib/timecode';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/shared/components/ui/empty';
import { Spinner } from '@/shared/components/ui/spinner';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { Tooltip } from '@/shared/ui/Tooltip';

function fmtSize(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

const STATUS_LABEL: Record<Compilation['status'], string> = {
  queued: 'Queued',
  running: 'Building',
  ready: 'Ready',
  failed: 'Failed',
};

const clipHref = (sessionId: string, startSec: number) =>
  `/sessions/${encodeURIComponent(sessionId)}?t=${Math.round(startSec * 100) / 100}`;

function CompilationCard({
  c,
  canWrite,
  onDelete,
  deleting,
}: {
  c: Compilation;
  canWrite: boolean;
  onDelete: () => void;
  deleting: boolean;
}) {
  const building = c.status === 'queued' || c.status === 'running';
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-ctl border border-si-line bg-si-panel p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="m-0 truncate text-base font-semibold text-si-fg">{c.title}</h2>
          <p className="m-0 text-xs text-si-dim">
            {c.clips.length} clip{c.clips.length === 1 ? '' : 's'} · {fmtShort(c.durationSec)}
            {c.sizeBytes ? ` · ${fmtSize(c.sizeBytes)}` : ''} ·{' '}
            {new Date(c.createdAt).toLocaleDateString()}
            {c.createdBy ? ` by ${c.createdBy.name}` : ''}
          </p>
        </div>
        <Badge
          variant={
            c.status === 'failed' ? 'destructive' : c.status === 'ready' ? 'secondary' : 'outline'
          }
        >
          {building && <Spinner role="presentation" aria-hidden="true" />}
          {STATUS_LABEL[c.status]}
        </Badge>
      </div>

      {building && (
        <p role="status" className="m-0 text-sm text-si-muted">
          {c.progress ?? 'Waiting for the worker'}
        </p>
      )}
      {c.status === 'failed' && (
        <p role="alert" className="m-0 text-sm break-words text-si-danger">
          {c.error ?? 'The build failed.'}
        </p>
      )}
      {c.status === 'ready' && c.url && (
        // biome-ignore lint/a11y/useMediaCaption: compilations of interview video have no caption track
        <video
          controls
          preload="metadata"
          src={c.url}
          className="aspect-video w-full rounded-ctl bg-black"
          aria-label={`${c.title} video`}
        />
      )}

      <details className="min-w-0 text-sm">
        <summary className="cursor-pointer text-si-muted hover:text-si-fg">Clips</summary>
        <ol className="m-0 mt-2 flex list-decimal flex-col gap-1 pl-6">
          {c.clips.map((clip, i) => (
            // Clips may repeat the same range; the position keeps keys unique.
            // biome-ignore lint/suspicious/noArrayIndexKey: order is the identity of a clip
            <li key={i} className="min-w-0 text-si-fg">
              <Link
                href={clipHref(clip.sessionId, clip.startSec)}
                className="text-si-fg underline-offset-2 hover:underline"
              >
                {clip.sessionTitle}
              </Link>{' '}
              <span className="font-mono text-xs text-si-dim">
                {fmtShort(clip.startSec)}–{fmtShort(clip.endSec)}
              </span>
              {clip.label && <span className="text-si-muted"> · {clip.label}</span>}
            </li>
          ))}
        </ol>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        {c.status === 'ready' && c.url && (
          <Button
            variant="outline"
            nativeButton={false}
            render={<a href={c.url} download={`${c.title}.mp4`} />}
          >
            <DownloadIcon data-icon="inline-start" />
            Download
          </Button>
        )}
        <Tooltip
          content="You can watch this show's compilations but not delete them."
          disabled={canWrite}
        >
          <span className="inline-flex">
            <Button variant="ghost" onClick={onDelete} disabled={!canWrite || deleting}>
              <Trash2Icon data-icon="inline-start" />
              Delete
            </Button>
          </span>
        </Tooltip>
      </div>
    </li>
  );
}

function CompilationList({ showId, canWrite }: { showId: string; canWrite: boolean }) {
  const { data, isPending, isError, error, refetch } = useCompilations(showId);
  const del = useDeleteCompilation(showId);
  const { confirm, confirmElement } = useConfirm();

  const onDelete = async (c: Compilation) => {
    const ok = await confirm({
      title: 'Delete this compilation?',
      message: `“${c.title}” and its video are deleted for everyone. This cannot be undone; the sessions are not affected.`,
      confirmLabel: 'Delete compilation',
      danger: true,
    });
    if (!ok) return;
    del.mutate(
      { compilationId: c.id },
      {
        onSuccess: () => showToast(`Deleted “${c.title}”.`),
        onError: (e) => showToast(`Couldn't delete the compilation: ${errorMessage(e)}`, true),
      },
    );
  };

  if (isError)
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center text-sm">
        <p className="m-0 text-si-fg">{errorMessage(error) || 'Could not load compilations.'}</p>
        <Button variant="outline" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  if (isPending)
    return (
      <div
        role="status"
        className="flex items-center justify-center gap-2 py-10 text-sm text-si-muted"
      >
        <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading compilations…
      </div>
    );
  if (data.length === 0)
    return (
      <div className="flex flex-col items-center gap-1 py-10 text-center">
        <p className="m-0 text-sm text-si-muted">No compilations yet.</p>
        <p className="m-0 max-w-[30rem] text-xs text-si-dim">
          Agents connected over MCP build them from moments in sessions imported from YouTube — for
          example “make a video of every time we talked about the dog”.
        </p>
      </div>
    );
  return (
    <>
      <ul aria-label="Compilations" className="m-0 flex list-none flex-col gap-3 p-0">
        {data.map((c) => (
          <CompilationCard
            key={c.id}
            c={c}
            canWrite={canWrite}
            deleting={del.isPending && del.variables?.compilationId === c.id}
            onDelete={() => void onDelete(c)}
          />
        ))}
      </ul>
      {confirmElement}
    </>
  );
}

export function CompilationsRoute() {
  const { show, showsLoading, canWriteShow } = useActive();
  const storage = useCapabilities().data?.storage;

  if (showsLoading) return <RouteLoadingState label="Loading compilations" />;

  return (
    <PageFrame className="max-md:px-3">
      <div data-slot="compilations-route" className="contents">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="m-0 text-[1.35rem] font-semibold text-si-fg">Compilations</h1>
          {show && <p className="m-0 truncate text-sm text-si-muted">{show.name}</p>}
        </div>
        {!show ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No show chosen</EmptyTitle>
              <EmptyDescription>
                Choose a show in the top bar to see its compilations.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : storage === false ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Media storage is not configured</EmptyTitle>
              <EmptyDescription>
                Compilations need S3 storage on this server (S3_BUCKET and credentials).
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <CompilationList showId={show.id} canWrite={canWriteShow} />
        )}
      </div>
    </PageFrame>
  );
}
