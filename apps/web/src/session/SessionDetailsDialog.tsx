// Session settings in one place (sessions.update): title, episode, date, notes and, while the
// transport is stopped, frame rate and start timecode. Key terms keep their own editor
// (KeyTermsDialog), opened from here.

import type { OpInput, Session } from '@autologger/contract';
import { InfoIcon, TagsIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { qk, useCapabilities, useJobs, useMedia, useOpMutation } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { NativeSelect } from '@/components/NativeSelect';
import { FRAME_RATES, formatFrames, parseTimecode } from '@/lib/timecode';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { Textarea } from '@/shared/components/ui/textarea';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { Dialog, DialogActions } from '@/shared/ui/Dialog';
import { KeyTermsDialog } from './KeyTermsDialog';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function SessionDetailsDialog({
  session: s,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const canWrite = s.access !== 'read';
  const initialTc = formatFrames(s.startOffsetFrames, s.frameRate);
  const [title, setTitle] = useState(s.title);
  const [episode, setEpisode] = useState(s.episode);
  const [date, setDate] = useState(s.episodeDate ?? '');
  const [notes, setNotes] = useState(s.notes);
  const [fps, setFps] = useState(s.frameRate);
  const [startTc, setStartTc] = useState(initialTc);
  const [termsOpen, setTermsOpen] = useState(false);
  const { confirm, confirmElement } = useConfirm();
  const update = useOpMutation('sessions.update', {
    invalidate: () => [qk.session(s.id), qk.sessionsAll],
  });

  const rates: number[] = FRAME_RATES.includes(s.frameRate as (typeof FRAME_RATES)[number])
    ? [...FRAME_RATES]
    : [...FRAME_RATES, s.frameRate].sort((a, b) => a - b);
  const tcValid = parseTimecode(startTc, fps) != null;
  const clockChanged = fps !== s.frameRate || startTc.trim() !== initialTc;
  const clockLocked = s.isRolling;
  // Logged events and the elapsed clock are stored as frames on the session clock.
  const clockInUse = s.eventCount > 0 || s.elapsedFrames > 0;

  const patch: OpInput<'sessions.update'> = {
    sessionId: s.id,
    ...(title.trim() !== s.title && { title: title.trim() }),
    ...(episode.trim() !== s.episode && { episode: episode.trim() }),
    ...((date || null) !== s.episodeDate && { episodeDate: date || null }),
    ...(notes !== s.notes && { notes }),
    ...(fps !== s.frameRate && { frameRate: fps }),
    // Sent with a frame rate change too, so the start offset is re-read at the new rate.
    ...(clockChanged && { startTimecode: startTc.trim() }),
  };
  const changed = Object.keys(patch).length > 1;
  const invalid = !title.trim()
    ? 'Enter a title.'
    : clockChanged && !tcValid
      ? `Use HH:MM:SS:FF for the start timecode, with frames below ${Math.round(fps)}.`
      : null;

  const requestClose = async () => {
    if (update.isPending) return;
    if (
      changed &&
      !(await confirm({
        title: 'Discard changes',
        message: 'Discard your unsaved session details?',
        confirmLabel: 'Discard',
        danger: true,
      }))
    )
      return;
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canWrite || !changed || invalid || update.isPending) return;
    update.mutate(patch, {
      onSuccess: () => {
        showToast('Session details saved.');
        onClose();
      },
    });
  };

  const disabled = !canWrite || update.isPending;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && void requestClose()}
      title="Session details"
      description={s.showName}
      className="md:max-w-lg"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="sd-title">Title</FieldLabel>
          <Input
            id="sd-title"
            maxLength={200}
            autoFocus={canWrite}
            disabled={disabled}
            aria-invalid={!title.trim() || undefined}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Field>
            <FieldLabel htmlFor="sd-episode">Episode</FieldLabel>
            <Input
              id="sd-episode"
              maxLength={40}
              disabled={disabled}
              value={episode}
              onChange={(e) => setEpisode(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="sd-date">Date</FieldLabel>
            <Input
              id="sd-date"
              type="date"
              disabled={disabled}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="sd-notes">Notes</FieldLabel>
          <Textarea
            id="sd-notes"
            maxLength={10000}
            disabled={disabled}
            placeholder={canWrite ? 'Session notes' : 'No notes.'}
            className="max-h-[40svh]"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Field>
            <FieldLabel htmlFor="sd-fps">Frame rate</FieldLabel>
            <NativeSelect
              id="sd-fps"
              disabled={disabled || clockLocked}
              value={String(fps)}
              onChange={(e) => {
                const next = Number(e.target.value);
                setFps(next);
                // Same digits, in the new rate's form (29.97 and 59.94 use ';').
                const f = parseTimecode(startTc, next);
                if (f != null) setStartTc(formatFrames(f, next));
              }}
            >
              {rates.map((r) => (
                <option key={r} value={r}>
                  {r} fps
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="sd-tc">Start timecode</FieldLabel>
            <Input
              id="sd-tc"
              className="font-tc"
              disabled={disabled || clockLocked}
              aria-invalid={(clockChanged && !tcValid) || undefined}
              value={startTc}
              onChange={(e) => setStartTc(e.target.value)}
            />
          </Field>
        </div>
        {(clockLocked || (clockChanged && clockInUse)) && (
          <FieldDescription className="-mt-2">
            {clockLocked
              ? 'Stop the transport to change the frame rate or start timecode.'
              : `Logged times are stored as frames, so ${s.eventCount ? `the ${plural(s.eventCount, 'event')}` : 'the recorded clock'} will move against the audio and transcript at the new setting.`}
          </FieldDescription>
        )}

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-ctl border border-si-line px-3 py-2">
          <div className="flex min-w-0 flex-1 basis-48 flex-col">
            <span className="text-sm font-semibold">Key terms</span>
            <span className="truncate text-xs text-muted-foreground">
              {s.keyTerms.length
                ? s.keyTerms.join(', ')
                : 'None. Names the transcriber listens for in this session.'}
            </span>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setTermsOpen(true)}>
            <TagsIcon aria-hidden="true" data-icon="inline-start" />
            {canWrite ? 'Edit key terms…' : 'Key terms…'}
          </Button>
        </div>

        {canWrite && invalid && (changed || !title.trim()) && (
          <p className="m-0 text-sm text-si-danger">{invalid}</p>
        )}
        {!canWrite && <p className="m-0 text-sm text-si-muted">Read-only access to this show.</p>}
        {update.error && (
          <Alert variant="destructive">
            <AlertDescription>
              Couldn't save the session details. {errorMessage(update.error)}
            </AlertDescription>
          </Alert>
        )}

        <DialogActions>
          <Button type="button" variant="outline" onClick={() => void requestClose()}>
            {canWrite ? 'Cancel' : 'Close'}
          </Button>
          {canWrite && (
            <Button type="submit" disabled={!changed || !!invalid || update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          )}
        </DialogActions>
      </form>
      {termsOpen && <SessionKeyTerms session={s} onClose={() => setTermsOpen(false)} />}
      {confirmElement}
    </Dialog>
  );
}

/** The key terms editor with the audio and job state it needs, loaded when it opens. */
function SessionKeyTerms({ session, onClose }: { session: Session; onClose: () => void }) {
  const caps = useCapabilities().data;
  const media = useMedia(session.id);
  const jobs = useJobs(session.id);
  const running = (jobs.data ?? []).filter(
    (j) => j.status === 'queued' || j.status === 'running',
  ).length;
  return (
    <KeyTermsDialog
      session={session}
      caps={caps}
      canWrite={session.access !== 'read'}
      segments={media.data}
      jobsRunning={running}
      onClose={onClose}
    />
  );
}

/** "Details" in the session workspace's tab row. */
export function SessionDetailsButton({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-si-muted hover:text-si-fg"
        onClick={() => setOpen(true)}
      >
        <InfoIcon aria-hidden="true" />
        <span className="max-md:sr-only">Details</span>
      </Button>
      {open && <SessionDetailsDialog session={session} onClose={() => setOpen(false)} />}
    </>
  );
}
