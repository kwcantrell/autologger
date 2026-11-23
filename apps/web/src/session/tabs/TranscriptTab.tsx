import type { Session } from '@autologger/contract';
import { FileUpIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCapabilities, useJobs, useMedia, useTranscript } from '@/api/queries';
import { errorMessage, rpc } from '@/api/rpc';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Spinner } from '@/shared/components/ui/spinner';
import { useTextPrompt } from '@/shared/ui/PromptDialog';
import { useWorkspace } from '../context';
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

export function TranscriptTab({
  session,
  playheadSec,
}: {
  session: Session;
  playheadSec: number | null;
}) {
  const { canWrite, seek } = useWorkspace();
  const caps = useCapabilities().data;
  const q = useTranscript(session.id);
  const jobs = useJobs(session.id);
  const media = useMedia(session.id);
  const [importOpen, setImportOpen] = useState(false);
  const { requestText, promptElement } = useTextPrompt();
  const segs = q.data ?? [];
  const running = (jobs.data ?? []).filter(
    (j) => j.kind.includes('transcri') && (j.status === 'queued' || j.status === 'running'),
  );
  const failed = (jobs.data ?? []).find(
    (j) => j.kind.includes('transcri') && j.status === 'failed',
  );

  const activeId = useMemo(() => {
    if (playheadSec == null) return null;
    return segs.find((s) => playheadSec >= s.startSec && playheadSec < s.endSec)?.id ?? null;
  }, [segs, playheadSec]);

  const renameSpeaker = async (from: string) => {
    const to = await requestText({
      title: 'Rename speaker',
      label: 'Speaker name',
      description: `Renames “${from}” in every segment of this session.`,
      initialValue: from,
      submitLabel: 'Rename',
    });
    if (!to || to.trim() === from) return;
    try {
      const r = await rpc('transcript.renameSpeaker', {
        sessionId: session.id,
        from,
        to: to.trim(),
      });
      showToast(`Renamed in ${r.updated} segment${r.updated === 1 ? '' : 's'}.`);
    } catch (e) {
      showToast(errorMessage(e), true);
    }
  };

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
            <SegmentRow
              key={s.id}
              s={s}
              active={s.id === activeId}
              playheadSec={s.id === activeId ? playheadSec : null}
              canWrite={canWrite}
              rolling={session.isRolling}
              onSeek={(sec) => seek(sec, true)}
              onRenameSpeaker={() => void renameSpeaker(s.speaker)}
              onSaveText={(text) =>
                rpc('transcript.updateSegment', { segmentId: s.id, text }).catch((e) => {
                  showToast(`Saving the segment failed. ${errorMessage(e)}`, true);
                  throw e;
                })
              }
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
}
