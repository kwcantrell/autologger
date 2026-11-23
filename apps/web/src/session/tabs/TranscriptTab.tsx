import type { Session, TranscriptSegment } from '@autologger/contract';
import { FileUpIcon } from 'lucide-react';
import { memo, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useJobs, useMedia, useTranscript } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { useSessionWrite } from '@/api/session/writes';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Spinner } from '@/shared/components/ui/spinner';
import { useTextPrompt } from '@/shared/ui/PromptDialog';
import type { Player } from '../audio/usePlayer';
import { indexAt, useSessionSlice, useWorkspace } from '../context';
import { FeedShell, FeedTable, ToolbarCaption } from '../feed';
import { TranscriptImportDialog } from '../TranscriptImportDialog';
import { SEGMENT_COLUMNS, SegmentRow } from './SegmentRow';

const STATUS: Record<Session['transcriptStatus'], string> = {
  none: 'No transcript',
  pending: 'Transcribing…',
  partial: 'Partly transcribed',
  done: 'Transcribed',
  failed: 'Transcription failed',
};

const noSubscribe = () => () => {};

/**
 * A SegmentRow that reads the playhead itself, and only while it is the active row: the tab and
 * the other rows don't re-render each frame of playback. Memoized on stable props.
 */
const TranscriptRow = memo(function TranscriptRow({
  s,
  position,
  canWrite,
  onSeek,
  onRenameSpeaker,
  onSaveText,
}: {
  s: TranscriptSegment;
  /** The player's position store while this row is under the playhead, else null. */
  position: Player['position'] | null;
  canWrite: boolean;
  onSeek: (sec: number) => void;
  onRenameSpeaker: (speaker: string) => void;
  onSaveText: (segmentId: string, text: string) => Promise<unknown>;
}) {
  const playheadSec = useSyncExternalStore(
    position?.subscribe ?? noSubscribe,
    () => position?.get() ?? null,
  );
  return (
    <SegmentRow
      s={s}
      active={position != null}
      playheadSec={playheadSec}
      canWrite={canWrite}
      onSeek={onSeek}
      onRenameSpeaker={() => onRenameSpeaker(s.speaker)}
      onSaveText={(text) => onSaveText(s.id, text)}
    />
  );
});

export const TranscriptTab = memo(function TranscriptTab() {
  const session = useSessionSlice((s) => ({
    id: s.id,
    title: s.title,
    audioSeconds: s.audioSeconds,
    transcriptStatus: s.transcriptStatus,
  }));

  const { canWrite, seek, player, caps } = useWorkspace();
  const q = useTranscript(session.id);
  const jobs = useJobs(session.id);
  // Same gate as the workspace's: without storage there is no media list to ask for.
  const media = useMedia(session.id, caps?.storage !== false);
  const [importOpen, setImportOpen] = useState(false);
  const { requestText, promptElement } = useTextPrompt();
  const segs = q.data ?? [];
  const running = (jobs.data ?? []).filter(
    (j) => j.kind.includes('transcri') && (j.status === 'queued' || j.status === 'running'),
  );
  const failed = (jobs.data ?? []).find(
    (j) => j.kind.includes('transcri') && j.status === 'failed',
  );

  // The segment under the playhead while playing; re-renders the tab only when it changes.
  // Segments come sorted by start: a binary search, not a scan of thousands per frame.
  const starts = useMemo(() => segs.map((s) => s.startSec), [segs]);
  const activeId = useSyncExternalStore(player.position.subscribe, () => {
    const sec = player.isPlaying ? player.position.get() : null;
    if (sec == null) return null;
    const i = indexAt(starts, sec);
    // The last segment starting at or before the playhead, or the one before it when they overlap.
    for (const s of [segs[i], segs[i - 1]]) if (s && sec < s.endSec) return s.id;
    return null;
  });
  const seekAndPlay = useCallback((sec: number) => seek(sec, true), [seek]);
  const write = useSessionWrite(session.id);
  const saveSegmentText = useCallback(
    (segmentId: string, text: string) =>
      write('transcript.updateSegment', { segmentId, text }).catch((e) => {
        showToast(`Saving the segment failed. ${errorMessage(e)}`, true);
        throw e;
      }),
    [write],
  );

  const renameSpeaker = useCallback(
    async (from: string) => {
      const to = await requestText({
        title: 'Rename speaker',
        label: 'Speaker name',
        description: `Renames “${from}” in every segment of this session.`,
        initialValue: from,
        submitLabel: 'Rename',
      });
      if (!to || to.trim() === from) return;
      try {
        const r = await write('transcript.renameSpeaker', {
          sessionId: session.id,
          from,
          to: to.trim(),
        });
        showToast(`Renamed in ${r.updated} segment${r.updated === 1 ? '' : 's'}.`);
      } catch (e) {
        showToast(errorMessage(e), true);
      }
    },
    [requestText, session.id, write],
  );

  const words = segs.reduce(
    (n, s) => n + (s.words.length || s.text.split(/\s+/).filter(Boolean).length),
    0,
  );

  const empty =
    caps && !caps.transcription
      ? "Transcription isn't configured on this server (DEEPGRAM_API_KEY), so audio isn't transcribed automatically. Agents can still add transcript segments over MCP."
      : session.transcriptStatus === 'pending' || running.length
        ? 'Transcribing… segments appear here as they finish.'
        : session.audioSeconds > 0
          ? 'No transcript yet for this audio.'
          : 'No transcript yet. Record or import audio and it is transcribed automatically.';
  const emptyHint = canWrite
    ? `${empty} Have a transcript already? Use Import transcript to load an SRT, VTT or JSON file.`
    : empty;

  return (
    <FeedShell
      countLabel={
        <span className="flex flex-wrap items-center gap-2">
          {`${words} word${words === 1 ? '' : 's'}`}
          <Badge variant="outline" title={failed?.error ?? undefined}>
            {running.length ? (
              <>
                <Spinner className="size-3" /> {running[0]?.progress ?? 'Transcribing…'}
              </>
            ) : (
              STATUS[session.transcriptStatus]
            )}
          </Badge>
        </span>
      }
      toolbar={
        canWrite && (
          <Button variant="glass" onClick={() => setImportOpen(true)}>
            <ToolbarCaption
              label="Import transcript…"
              icon={<FileUpIcon className="block size-[18px]" aria-hidden="true" />}
            />
          </Button>
        )
      }
    >
      {failed && session.transcriptStatus === 'failed' && (
        <p className="m-0 mb-2 text-[0.85rem] text-si-danger">
          Last transcription failed: {failed.error ?? 'unknown error'}.
        </p>
      )}
      {q.isError ? (
        <p className="m-0 text-sm text-si-danger">
          Couldn't load the transcript. {errorMessage(q.error)}
        </p>
      ) : (
        <FeedTable
          columns={SEGMENT_COLUMNS}
          loading={q.isPending}
          empty={segs.length === 0}
          emptyMessage={emptyHint}
        >
          {segs.map((s) => (
            <TranscriptRow
              key={s.id}
              s={s}
              position={s.id === activeId ? player.position : null}
              canWrite={canWrite}
              onSeek={seekAndPlay}
              onRenameSpeaker={renameSpeaker}
              onSaveText={saveSegmentText}
            />
          ))}
        </FeedTable>
      )}
      {promptElement}
      {importOpen && (
        <TranscriptImportDialog
          session={session}
          segments={media.data}
          onClose={() => setImportOpen(false)}
        />
      )}
    </FeedShell>
  );
});
