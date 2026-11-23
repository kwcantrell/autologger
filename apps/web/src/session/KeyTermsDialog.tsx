// Per-session transcription key terms (sessions.update keyTerms): names and jargon said in this
// session, such as guests. Sent before the show's key terms on every transcription of the
// session; optionally re-transcribe right away with the new list.

import {
  type AudioSegment,
  type Capabilities,
  keyTermsChars,
  MAX_KEY_TERM_LENGTH,
  MAX_KEY_TERMS,
  MAX_KEY_TERMS_TOTAL_CHARS,
  type Session,
} from '@autologger/contract';
import { XIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { qk, useOpMutation, useShow } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { Dialog, DialogActions } from '@/shared/ui/Dialog';
import { Tooltip } from '@/shared/ui/Tooltip';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Why `terms` can't be saved (the API's limits), or null. */
function limitError(terms: string[]): string | null {
  if (terms.length > MAX_KEY_TERMS)
    return `At most ${MAX_KEY_TERMS} key terms; this list has ${terms.length}.`;
  const long = terms.find((t) => t.length > MAX_KEY_TERM_LENGTH);
  if (long) return `“${long.slice(0, 24)}…” is longer than ${MAX_KEY_TERM_LENGTH} characters.`;
  const over = keyTermsChars(terms) - MAX_KEY_TERMS_TOTAL_CHARS;
  if (over > 0)
    return `Key terms can total ${MAX_KEY_TERMS_TOTAL_CHARS} characters; remove ${over} more.`;
  return null;
}

export function KeyTermsDialog({
  session,
  caps,
  canWrite,
  segments,
  jobsRunning,
  onClose,
}: {
  session: Session;
  caps: Capabilities | undefined;
  canWrite: boolean;
  segments: AudioSegment[] | undefined;
  /** Queued or running jobs of this session: a re-transcribe would reuse them (old terms). */
  jobsRunning: number;
  onClose: () => void;
}) {
  const show = useShow(session.showId).data;
  const [terms, setTerms] = useState<string[]>(session.keyTerms);
  const [entry, setEntry] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);
  const { confirm, confirmElement } = useConfirm();
  const update = useOpMutation('sessions.update', {
    invalidate: () => [qk.session(session.id), qk.sessionsAll],
  });
  const retranscribe = useOpMutation('media.retranscribe', {
    invalidate: () => [qk.jobs(session.id), qk.media(session.id)],
  });
  const busy = update.isPending || retranscribe.isPending;
  const error = update.error ?? retranscribe.error;

  const changed = terms.join('\n') !== session.keyTerms.join('\n');
  const listError = limitError(terms);
  const charsLeft = MAX_KEY_TERMS_TOTAL_CHARS - keyTermsChars(terms);
  // Re-transcribing needs transcription on the server and audio that has finished uploading.
  const audio = (segments ?? []).filter((s) => s.status !== 'uploading');
  const canRetranscribe = canWrite && !!caps?.transcription && audio.length > 0;
  const retranscribeBlocked =
    jobsRunning > 0 ? 'A transcription is already running; re-transcribe when it finishes.' : null;

  /** Close, asking first when edits (or a typed term) would be lost. */
  const requestClose = async () => {
    if (busy) return;
    if (
      (changed || entry.trim()) &&
      !(await confirm({
        title: 'Discard changes',
        message: 'Discard your unsaved key term changes?',
        confirmLabel: 'Discard',
        danger: true,
      }))
    )
      return;
    onClose();
  };

  /** Add `text` (one term per line) to the list: the new list, or null when it breaks a limit. */
  const addTerms = (text: string): string[] | null => {
    const added = text
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    const next = [...new Set([...terms, ...added])];
    const problem = limitError(next);
    if (problem) {
      setEntryError(problem);
      return null;
    }
    setTerms(next);
    setEntry('');
    setEntryError(null);
    return next;
  };

  const save = async (andRetranscribe: boolean) => {
    if (busy) return;
    // A term still in the entry box is saved too.
    const list = entry.trim() ? addTerms(entry) : terms;
    if (!list || limitError(list)) return;
    const listChanged = list.join('\n') !== session.keyTerms.join('\n');
    if (andRetranscribe && retranscribeBlocked) return;
    if (andRetranscribe) {
      const ok = await confirm({
        title: 'Re-transcribe session',
        message: `Transcribe ${audio.length === 1 ? 'the audio' : `all ${audio.length} audio segments`} of “${session.title}” again with these key terms? The machine transcript is replaced and manual edits to it are lost.`,
        confirmLabel: 'Re-transcribe',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      if (listChanged) await update.mutateAsync({ sessionId: session.id, keyTerms: list });
      if (andRetranscribe) {
        await retranscribe.mutateAsync({ sessionId: session.id });
        showToast('Key terms saved. Re-transcribing; the Transcript tab shows progress.');
      } else showToast('Key terms saved.');
      onClose();
    } catch {
      // Shown below from the mutation's error.
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Enter in the entry box adds the term; with the box empty it saves.
    if (entry.trim()) addTerms(entry);
    else if (changed) void save(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && void requestClose()}
      title="Key terms"
      description={session.title}
      className="md:max-w-lg"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <p className="m-0 text-sm text-si-muted">
          Names and jargon said in this session, such as a guest’s name. The transcriber listens for
          them in future transcriptions of this session and when it is re-transcribed; the show’s
          key terms are sent after them.
        </p>

        {terms.length > 0 ? (
          <ul aria-label="Session key terms" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {terms.map((t) => (
              <li key={t} className="min-w-0 max-w-full">
                <Badge
                  variant="outline"
                  className="h-auto max-w-full gap-1 py-0.5 pr-0.5 normal-case"
                >
                  <span className="min-w-0 truncate" title={t}>
                    {t}
                  </span>
                  {canWrite && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${t}`}
                      disabled={busy}
                      onClick={() => setTerms(terms.filter((x) => x !== t))}
                    >
                      <XIcon aria-hidden="true" />
                    </Button>
                  )}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-si-dim">No key terms for this session.</p>
        )}

        {canWrite ? (
          <Field>
            <FieldLabel htmlFor="kt-entry">Add a key term</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="kt-entry"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="Guest name"
                disabled={busy || terms.length >= MAX_KEY_TERMS}
                aria-invalid={entryError ? true : undefined}
                aria-describedby="kt-entry-help"
                value={entry}
                onChange={(e) => {
                  setEntry(e.target.value);
                  setEntryError(null);
                }}
                onPaste={(e) => {
                  // Pasted lines become one term each (an input would join them).
                  const text = e.clipboardData.getData('text');
                  if (!text.includes('\n')) return;
                  e.preventDefault();
                  addTerms(`${entry}\n${text}`);
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy || !entry.trim()}
                onClick={() => addTerms(entry)}
              >
                Add
              </Button>
            </div>
            <FieldDescription
              id="kt-entry-help"
              className={entryError || listError ? 'text-si-danger' : undefined}
            >
              {entryError ??
                listError ??
                `Press Enter to add. ${terms.length} of ${MAX_KEY_TERMS} terms, up to ${MAX_KEY_TERM_LENGTH} characters each; ${plural(Math.max(charsLeft, 0), 'character')} left.`}
            </FieldDescription>
          </Field>
        ) : (
          <p className="m-0 text-sm text-si-muted">Read-only access to this show.</p>
        )}

        <p className="m-0 text-sm text-si-muted">
          {show == null
            ? 'Loading the show’s key terms…'
            : show.keyTerms.length
              ? `Show key terms, sent for every session: ${show.keyTerms.join(', ')}.`
              : 'The show has no key terms.'}{' '}
          Keep show key terms to names said in every session.
        </p>

        {canRetranscribe && retranscribeBlocked && (
          <p className="m-0 text-sm text-si-muted">{retranscribeBlocked}</p>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(error)}</AlertDescription>
          </Alert>
        )}

        <DialogActions>
          <Button type="button" variant="outline" onClick={() => void requestClose()}>
            {canWrite ? 'Cancel' : 'Close'}
          </Button>
          {canRetranscribe && (
            <Tooltip
              content={
                retranscribeBlocked ??
                "Save, then transcribe this session's audio again with these key terms"
              }
              disabled={busy || !!listError || !!retranscribeBlocked}
              titleWhenDisabled
            >
              <Button
                type="button"
                variant="outline"
                disabled={busy || !!listError || !!retranscribeBlocked}
                onClick={() => void save(true)}
              >
                {retranscribe.isPending ? 'Starting…' : 'Save & re-transcribe'}
              </Button>
            </Tooltip>
          )}
          {canWrite && (
            <Button
              type="button"
              disabled={busy || (!changed && !entry.trim()) || !!listError}
              onClick={() => void save(false)}
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          )}
        </DialogActions>
      </form>
      {confirmElement}
    </Dialog>
  );
}
