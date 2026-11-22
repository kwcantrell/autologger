// One compilation on the Compilations page: status, progress or error, the video, its clips and
// the Download / Retry / Delete actions. Presentational (props in, markup out; actions are
// callbacks), so the landing page mock renders it too.

import type { Compilation } from '@autologger/contract';
import { DownloadIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { Link } from 'wouter';
import { fmtEta } from '@/app/ShowJobs';
import { fmtShort } from '@/lib/timecode';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Spinner } from '@/shared/components/ui/spinner';
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

/** "next in line · about 2 min left" from a compilation's queuePosition and etaSec, or null. */
function fmtWait(c: Compilation): string | null {
  const parts = [
    c.queuePosition === undefined
      ? null
      : c.queuePosition === 0
        ? 'next in line'
        : `${c.queuePosition} job${c.queuePosition === 1 ? '' : 's'} ahead`,
    fmtEta(c.etaSec),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

const clipHref = (sessionId: string, startSec: number) =>
  `/sessions/${encodeURIComponent(sessionId)}?t=${Math.round(startSec * 100) / 100}`;

export function CompilationCard({
  c,
  canWrite,
  onDelete,
  deleting,
  onRetry,
  retrying,
}: {
  c: Compilation;
  canWrite: boolean;
  onDelete: () => void;
  deleting: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
  const building = c.status === 'queued' || c.status === 'running';
  const wait = building ? fmtWait(c) : null;
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
          {wait && ` · ${wait}`}
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
        {c.status === 'failed' && (
          <Tooltip
            content="You can watch this show's compilations but not build them again."
            disabled={canWrite}
          >
            <span className="inline-flex">
              <Button variant="outline" onClick={onRetry} disabled={!canWrite || retrying}>
                <RefreshCwIcon data-icon="inline-start" />
                {retrying ? 'Retrying…' : 'Retry'}
              </Button>
            </span>
          </Tooltip>
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
