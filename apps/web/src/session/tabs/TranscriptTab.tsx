import type { Session, TranscriptSegment } from '@autologger/contract';
import { PencilIcon } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useCapabilities, useJobs, useTranscript } from '@/api/queries';
import { errorMessage, rpc } from '@/api/rpc';
import { fmtSec } from '@/lib/timecode';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Spinner } from '@/shared/components/ui/spinner';
import { cn } from '@/shared/lib/utils';
import { useTextPrompt } from '@/shared/ui/PromptDialog';
import { useWorkspace } from '../context';
import {
  FEED_CELL,
  FEED_CELL_LABEL,
  FEED_CELL_TEXT,
  FEED_ROW,
  FEED_TC,
  FEED_TEXTAREA,
  FeedShell,
  FeedTable,
  JUMP_COLUMN,
  JumpButton,
} from '../feed';

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
          columns={[
            JUMP_COLUMN,
            { key: 'time', label: 'Session Time', className: 'w-[6.5rem]' },
            { key: 'speaker', label: 'Speaker', className: 'w-32' },
            { key: 'text', label: 'Words' },
          ]}
          loading={q.isPending}
          empty={segs.length === 0}
          emptyMessage={empty}
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
            />
          ))}
        </FeedTable>
      )}
      {promptElement}
    </FeedShell>
  );
}

const SegmentRow = memo(function SegmentRow({
  s,
  active,
  playheadSec,
  canWrite,
  rolling,
  onSeek,
  onRenameSpeaker,
}: {
  s: TranscriptSegment;
  active: boolean;
  playheadSec: number | null;
  canWrite: boolean;
  rolling: boolean;
  onSeek: (sec: number) => void;
  onRenameSpeaker: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.text);
  const rowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => setText(s.text), [s.text]);
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const save = async () => {
    setEditing(false);
    if (text.trim() === s.text) return;
    try {
      await rpc('transcript.updateSegment', { segmentId: s.id, text: text.trim() });
    } catch (e) {
      showToast(`Saving the segment failed. ${errorMessage(e)}`, true);
      setText(s.text);
    }
  };

  const useWords = s.words.length > 0 && !s.edited;

  return (
    <tr ref={rowRef} className={cn(FEED_ROW, 'group', active && 'bg-(--sel-bg)')}>
      <td className={cn(FEED_CELL, 'align-top pt-1')}>
        <JumpButton
          sec={s.startSec}
          label={fmtSec(s.startSec)}
          onJump={onSeek}
          unavailable={rolling ? 'Playback is off while timecode rolls.' : null}
        />
      </td>
      <td className={cn(FEED_CELL, FEED_TC, 'align-top pt-1.5')}>{fmtSec(s.startSec)}</td>
      <td className={cn(FEED_CELL, FEED_CELL_LABEL, 'align-top pt-1.5')}>
        {canWrite ? (
          <button
            type="button"
            className="text-left hover:underline"
            title="Rename this speaker everywhere"
            onClick={onRenameSpeaker}
          >
            {s.speaker || 'Unknown'}
          </button>
        ) : (
          s.speaker || 'Unknown'
        )}
      </td>
      <td className={cn(FEED_CELL, FEED_CELL_TEXT, 'align-top py-1 leading-[1.5]')}>
        {editing ? (
          <textarea
            className={cn(
              FEED_TEXTAREA,
              'w-full rounded-[3px] border border-[color-mix(in_oklab,var(--si-accent)_55%,transparent)] bg-[color-mix(in_oklab,var(--si-accent)_8%,transparent)] px-1 py-0.5 text-inherit outline-none',
            )}
            // biome-ignore lint/a11y/noAutofocus: the user just chose Edit; focus moves into the field
            autoFocus
            aria-label="Segment text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setText(s.text);
                setEditing(false);
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
          />
        ) : (
          <span className="flex items-start gap-1">
            <span className="min-w-0 flex-1">
              {useWords
                ? s.words.map((w) => {
                    const cur = playheadSec != null && playheadSec >= w.s && playheadSec < w.e;
                    return (
                      <span key={`${w.s}:${w.w}`}>
                        <button
                          type="button"
                          className={cn(
                            'cursor-pointer rounded-[2px] px-[1px] hover:bg-[rgba(255,255,255,0.06)]',
                            cur && 'bg-si-accent/35 text-si-fg',
                          )}
                          onClick={() => !rolling && onSeek(w.s)}
                          title={fmtSec(w.s)}
                        >
                          {w.w}
                        </button>{' '}
                      </span>
                    );
                  })
                : s.text}
              {s.edited && <span className="ml-1 text-[0.65rem] text-si-dim">(edited)</span>}
            </span>
            {canWrite && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
                aria-label="Edit segment"
                onClick={() => setEditing(true)}
              >
                <PencilIcon aria-hidden="true" />
              </Button>
            )}
          </span>
        )}
      </td>
    </tr>
  );
});
