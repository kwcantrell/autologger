// One compilation on the Compilations page: status, progress or error (or, for one waiting for a
// local build, the import helper command to run), the video, its clips and the Download / Retry /
// Delete actions. A server build that failed on YouTube's bot check or a sign-in also offers the
// sign-in help and "Build on my computer" (compilations.retry buildLocally). Presentational (props in, markup out; actions are
// callbacks), so the landing page mock renders it too.

import type { Compilation } from '@autologger/contract';
import { DownloadIcon, LaptopIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { fmtEta } from '@/app/ShowJobs';
import { isYoutubeAuthError } from '@/app/YoutubeAuthHelp';
import { fmtShort } from '@/lib/timecode';
import { CopyRow } from '@/session/tabs/CopyRow';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleSummary,
} from '@/shared/components/ui/collapsible';
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

/** The import helper command that builds a buildLocally compilation (docs/developers/import-helper.md). */
export const localBuildCommand = (id: string) => `node autologger-import.mjs compile ${id}`;

const clipHref = (sessionId: string, startSec: number) =>
  `/sessions/${encodeURIComponent(sessionId)}?t=${Math.round(startSec * 100) / 100}`;

export function CompilationCard({
  c,
  canWrite,
  onDelete,
  deleting,
  onRetry,
  retrying,
  onCopy,
  onOpenHelper,
  onBuildLocally,
  switching = false,
  authHelp,
}: {
  c: Compilation;
  canWrite: boolean;
  onDelete: () => void;
  deleting: boolean;
  onRetry: () => void;
  retrying: boolean;
  /** Copies the local build command (buildLocally compilations waiting for it). */
  onCopy?: (value: string) => void;
  /** Opens the import helper's setup (Settings › Agents). */
  onOpenHelper?: () => void;
  /** Switches a failed server build to a local build with the import helper. */
  onBuildLocally?: () => void;
  switching?: boolean;
  /** Shown under a YouTube sign-in error: how to fix the team's sign-in (YoutubeAuthHelp). */
  authHelp?: ReactNode;
}) {
  const building = c.status === 'queued' || c.status === 'running';
  // Created with buildLocally: no worker job, it waits for the import helper on someone's computer.
  const local = c.buildLocally && c.status === 'queued';
  const wait = building && !local ? fmtWait(c) : null;
  // The server could not download the videos: YouTube wants a sign-in (bot check, private video).
  const authFailed = c.status === 'failed' && isYoutubeAuthError(c.error);
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
          {building && !local && <Spinner role="presentation" aria-hidden="true" />}
          {local ? 'Local build' : STATUS_LABEL[c.status]}
        </Badge>
      </div>

      {local && (
        <div className="flex min-w-0 flex-col gap-2">
          <p role="status" className="m-0 text-sm text-si-muted">
            Waiting for a local build. Run this on your computer with the AutoLogger import helper
            (add <code className="font-tc text-xs">--cookies-from-browser &lt;browser&gt;</code> for
            private videos); the video appears here when it is uploaded.
            {onOpenHelper && (
              <>
                {' '}
                <Button variant="link" size="xs" className="h-auto px-0" onClick={onOpenHelper}>
                  Set up the import helper
                </Button>
              </>
            )}
          </p>
          {onCopy && (
            <CopyRow label="Build command" value={localBuildCommand(c.id)} onCopy={onCopy} />
          )}
        </div>
      )}
      {building && !local && (
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
      {authFailed && (
        <div className="flex min-w-0 flex-col gap-1 text-sm text-si-muted">
          <p className="m-0">
            YouTube wants a sign-in before this server can download the videos. Set the team’s
            YouTube sign-in and retry, or build the video on your computer with the import helper,
            which uses your own browser’s sign-in.
          </p>
          {authHelp}
        </div>
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

      <Collapsible className="min-w-0 text-sm">
        <CollapsibleSummary className="text-si-muted hover:text-si-fg">Clips</CollapsibleSummary>
        <CollapsibleContent hiddenUntilFound>
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
        </CollapsibleContent>
      </Collapsible>

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
        {authFailed && onBuildLocally && (
          <Tooltip
            content="You can watch this show's compilations but not build them again."
            disabled={canWrite}
          >
            <span className="inline-flex">
              <Button
                variant="outline"
                onClick={onBuildLocally}
                disabled={!canWrite || switching || retrying}
              >
                <LaptopIcon data-icon="inline-start" />
                {switching ? 'Switching…' : 'Build on my computer'}
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
