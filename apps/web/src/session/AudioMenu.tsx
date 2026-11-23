// Audio sources for a session: import a local file, import a YouTube link, see segments and
// jobs; plus the banner for uploads still in flight or failed. Every unavailable action says why.

import type { AudioSegment, Capabilities, Session } from '@autologger/contract';
import {
  AudioLinesIcon,
  FileAudioIcon,
  FileUpIcon,
  LinkIcon,
  RefreshCwIcon,
  TagsIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { useJobs } from '@/api/queries';
import { errorMessage, type RpcError } from '@/api/rpc';
import { useSessionMutation } from '@/api/session/writes';
import { isYoutubeAuthError, YoutubeAuthHelp } from '@/app/YoutubeAuthHelp';
import { useStore } from '@/lib/store';
import { fmtSec } from '@/lib/timecode';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldLabel } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { Dialog, DialogActions } from '@/shared/ui/Dialog';
import { Tooltip } from '@/shared/ui/Tooltip';
import {
  discardUpload,
  downloadUpload,
  enqueueUpload,
  probeDuration,
  retryUpload,
  uploadQueue,
} from './audio/uploads';
import { KeyTermsDialog } from './KeyTermsDialog';
import { TranscriptImportDialog } from './TranscriptImportDialog';

const STATUS_LABEL: Record<AudioSegment['status'], string> = {
  uploading: 'Uploading',
  ready: 'Ready',
  transcribing: 'Transcribing',
  transcribed: 'Transcribed',
  failed: 'Failed',
};

export function AudioMenu({
  session,
  caps,
  canWrite,
  segments,
  mediaError,
}: {
  session: Session;
  caps: Capabilities | undefined;
  canWrite: boolean;
  segments: AudioSegment[] | undefined;
  mediaError: RpcError | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [ytOpen, setYtOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const jobs = useJobs(session.id);
  const activeJobs = (jobs.data ?? []).filter(
    (j) => j.status === 'queued' || j.status === 'running',
  );

  const storageReason =
    caps && !caps.storage ? "Audio storage isn't configured on this server (S3 settings)." : null;
  const writeReason = canWrite ? null : 'Read-only access to this show.';
  const fileReason = writeReason ?? storageReason;
  const ytReason =
    writeReason ??
    (caps && !caps.youtube
      ? (storageReason ?? 'YouTube import is turned off on this server (YOUTUBE_IMPORT).')
      : null);

  const onFile = async (file: File) => {
    const durationSec = await probeDuration(file);
    const lastEnd = (segments ?? []).reduce(
      (m, s) => Math.max(m, s.startSec + (s.durationSec ?? 0)),
      0,
    );
    enqueueUpload({
      sessionId: session.id,
      blob: file,
      mimeType: file.type || 'audio/mpeg',
      origin: 'file',
      fileName: file.name,
      startSec: lastEnd,
      durationSec,
    });
    showToast(`Uploading ${file.name}…`);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="sm" className="text-si-muted hover:text-si-fg" />}
        >
          <AudioLinesIcon aria-hidden="true" />
          <span className="max-xl:sr-only">Audio</span>
          {activeJobs.length > 0 && (
            <Badge variant="outline" className="animate-yt-import-pulse motion-reduce:animate-none">
              {activeJobs.length} running
            </Badge>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[300px]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Add audio</DropdownMenuLabel>
            <DropdownMenuItem disabled={!!fileReason} onClick={() => fileRef.current?.click()}>
              <FileAudioIcon aria-hidden="true" />
              <span className="flex flex-col">
                <span>Import audio file…</span>
                {fileReason && <span className="text-xs text-muted-foreground">{fileReason}</span>}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!!ytReason} onClick={() => setYtOpen(true)}>
              <LinkIcon aria-hidden="true" />
              <span className="flex flex-col">
                <span>Import from YouTube…</span>
                {ytReason && <span className="text-xs text-muted-foreground">{ytReason}</span>}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!!writeReason} onClick={() => setImportOpen(true)}>
              <FileUpIcon aria-hidden="true" />
              <span className="flex flex-col">
                <span>Import transcript…</span>
                <span className="text-xs text-muted-foreground">
                  {writeReason ?? 'An SRT, VTT or JSON file, for the session or one recording'}
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setListOpen(true)}>
            <AudioLinesIcon aria-hidden="true" />
            <span>
              Audio segments ({segments?.length ?? 0}){caps && !caps.transcription ? '' : ''}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTermsOpen(true)}>
            <TagsIcon aria-hidden="true" />
            <span className="flex flex-col">
              <span>Key terms ({session.keyTerms.length})…</span>
              <span className="text-xs text-muted-foreground">
                Names the transcriber listens for in this session
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,video/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void onFile(f);
        }}
      />
      {termsOpen && (
        <KeyTermsDialog
          session={session}
          caps={caps}
          canWrite={canWrite}
          segments={segments}
          jobsRunning={activeJobs.length}
          onClose={() => setTermsOpen(false)}
        />
      )}
      {importOpen && (
        <TranscriptImportDialog
          session={session}
          segments={segments}
          onClose={() => setImportOpen(false)}
        />
      )}
      {ytOpen && <YoutubeDialog sessionId={session.id} onClose={() => setYtOpen(false)} />}
      {listOpen && (
        <SegmentsDialog
          session={session}
          caps={caps}
          canWrite={canWrite}
          segments={segments}
          mediaError={mediaError}
          jobs={jobs.data ?? []}
          onClose={() => setListOpen(false)}
        />
      )}
    </>
  );
}

function YoutubeDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const imp = useSessionMutation(sessionId, 'media.importYoutube');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Import from YouTube">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          imp.mutate(
            { sessionId, url: url.trim() },
            {
              onSuccess: () => {
                showToast(
                  'YouTube import started. The audio appears here when the download finishes.',
                );
                onClose();
              },
            },
          );
        }}
      >
        <Field>
          <FieldLabel htmlFor="yt-url">Link to YouTube video</FieldLabel>
          <Input
            id="yt-url"
            autoFocus
            type="url"
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <FieldDescription>
            The server downloads the audio in the background and adds it to this session.
          </FieldDescription>
        </Field>
        {imp.error && (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>
              Could not start the import. {errorMessage(imp.error)}
              {isYoutubeAuthError(errorMessage(imp.error)) && (
                <YoutubeAuthHelp onNavigate={onClose} />
              )}
            </AlertDescription>
          </Alert>
        )}
        <DialogActions>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!url.trim() || imp.isPending}>
            {imp.isPending ? 'Starting…' : 'Import'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function SegmentsDialog({
  session,
  caps,
  canWrite,
  segments,
  mediaError,
  jobs,
  onClose,
}: {
  session: Session;
  caps: Capabilities | undefined;
  canWrite: boolean;
  segments: AudioSegment[] | undefined;
  mediaError: RpcError | null;
  jobs: import('@autologger/contract').Job[];
  onClose: () => void;
}) {
  const { confirm, confirmElement } = useConfirm();
  const del = useSessionMutation(session.id, 'media.delete');
  const retr = useSessionMutation(session.id, 'media.retranscribe');
  const rewave = useSessionMutation(session.id, 'media.rewaveform', {
    onSuccess: () => showToast('Waveform queued.'),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Audio segments"
      description={session.title}
      className="md:max-w-xl"
    >
      <div className="flex flex-col gap-3">
        {caps && !caps.storage && (
          <Alert>
            <TriangleAlertIcon />
            <AlertDescription>
              Audio storage isn't configured on this server, so audio can't be recorded, imported or
              played.
            </AlertDescription>
          </Alert>
        )}
        {caps?.storage && !caps.transcription && (
          <Alert>
            <TriangleAlertIcon />
            <AlertDescription>
              Transcription isn't configured on this server (DEEPGRAM_API_KEY), so audio is stored
              and playable but not transcribed.
            </AlertDescription>
          </Alert>
        )}
        {mediaError && (
          <p className="m-0 text-sm text-si-danger">
            Couldn't load the audio list. {errorMessage(mediaError)}
          </p>
        )}
        {segments && segments.length === 0 && (
          <p className="m-0 text-sm text-si-muted">
            No audio yet. Record while timecode rolls, or import a file or a YouTube link.
          </p>
        )}
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {segments?.map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-2 rounded-ctl border border-si-line px-3 py-2 text-sm"
            >
              <span className="font-tc text-xs tabular-nums text-si-muted">
                {fmtSec(s.startSec)}
                {s.durationSec != null && `–${fmtSec(s.startSec + s.durationSec)}`}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {s.fileName ??
                  (s.origin === 'recorded'
                    ? `Recording ${s.ordinal}`
                    : s.origin === 'youtube'
                      ? 'YouTube audio'
                      : `Segment ${s.ordinal}`)}
              </span>
              <Badge
                variant={s.status === 'failed' ? 'destructive' : 'outline'}
                title={s.error ?? undefined}
              >
                {STATUS_LABEL[s.status]}
              </Badge>
              {canWrite &&
                caps?.transcription &&
                (s.status === 'failed' || s.status === 'transcribed' || s.status === 'ready') && (
                  <Tooltip content="Transcribe again">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Transcribe again"
                      onClick={() =>
                        retr.mutate(
                          { sessionId: session.id, segmentId: s.id },
                          { onError: (e) => showToast(errorMessage(e), true) },
                        )
                      }
                    >
                      <RefreshCwIcon aria-hidden="true" />
                    </Button>
                  </Tooltip>
                )}
              {canWrite && caps?.storage && !s.hasWaveform && s.status !== 'uploading' && (
                <Tooltip
                  content="Compute waveform again (no waveform on the timeline yet)"
                  disabled={rewave.isPending && rewave.variables?.segmentId === s.id}
                  titleWhenDisabled
                >
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Compute waveform again"
                    disabled={rewave.isPending && rewave.variables?.segmentId === s.id}
                    onClick={() =>
                      rewave.mutate(
                        { sessionId: session.id, segmentId: s.id },
                        { onError: (e) => showToast(errorMessage(e), true) },
                      )
                    }
                  >
                    <AudioLinesIcon aria-hidden="true" />
                  </Button>
                </Tooltip>
              )}
              {canWrite && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-si-danger"
                  onClick={async () => {
                    if (
                      await confirm({
                        title: 'Delete audio segment',
                        message:
                          'Delete this audio and the transcript made from it? This cannot be undone.',
                        confirmLabel: 'Delete',
                        danger: true,
                      })
                    )
                      del.mutate(
                        { segmentId: s.id },
                        { onError: (e) => showToast(errorMessage(e), true) },
                      );
                  }}
                >
                  Delete
                </Button>
              )}
            </li>
          ))}
        </ul>
        {jobs.length > 0 && (
          <>
            <h3 className="m-0 mt-2 font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim">
              Background jobs
            </h3>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
              {jobs.slice(0, 10).map((j) => (
                <li key={j.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {j.kind}
                    {j.progress ? ` · ${j.progress}` : ''}
                  </span>
                  <Badge
                    variant={j.status === 'failed' ? 'destructive' : 'outline'}
                    title={j.error ?? undefined}
                  >
                    {j.status}
                  </Badge>
                  {j.error && (
                    <span className="max-w-[14rem] truncate text-xs text-si-danger" title={j.error}>
                      {j.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {confirmElement}
    </Dialog>
  );
}

/** Uploads still in flight or failed for this session (in-memory queue). */
export function UploadBanner({ sessionId }: { sessionId: string }) {
  const all = useStore(uploadQueue).filter((u) => u.sessionId === sessionId);
  if (all.length === 0) return null;
  const failed = all.filter((u) => u.state === 'failed');
  return (
    <Alert
      className="mx-4 w-auto max-md:mx-3"
      variant={failed.length ? 'destructive' : 'default'}
      role="status"
    >
      <AudioLinesIcon />
      <AlertTitle>
        {failed.length
          ? `${failed.length} audio upload${failed.length === 1 ? '' : 's'} failed`
          : `Uploading ${all.length} audio segment${all.length === 1 ? '' : 's'}…`}
      </AlertTitle>
      <AlertDescription>
        <p className="m-0">
          Keep this tab open until uploads finish; unsent audio lives only in this tab.
        </p>
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
          {all.map((u) => (
            <li key={u.key} className="flex flex-wrap items-center gap-2">
              <span className="font-tc text-xs tabular-nums">
                {u.startSec != null ? fmtSec(u.startSec) : '—'}
              </span>
              <span className="min-w-0 flex-1 truncate">{u.fileName ?? 'Recording'}</span>
              <span className="text-xs">
                {u.state === 'uploading'
                  ? `${Math.round(u.progress * 100)}%`
                  : u.state === 'queued'
                    ? 'Waiting'
                    : (u.error ?? 'Failed')}
              </span>
              {u.state === 'failed' && (
                <>
                  <Button size="xs" variant="outline" onClick={() => retryUpload(u.key)}>
                    Retry
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => downloadUpload(u)}>
                    Download
                  </Button>
                  <Button size="xs" variant="destructive" onClick={() => discardUpload(u.key)}>
                    Discard
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
