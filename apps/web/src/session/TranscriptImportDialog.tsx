// Import an SRT / WebVTT / JSON transcript file into the session (transcript.import), for the whole
// session or onto one recording, replacing or adding to the transcript there. The file is read in
// the browser and sent as text; parse errors from the server name the line.

import {
  type AudioSegment,
  MAX_TRANSCRIPT_IMPORT_CHARS,
  type OpOutputs,
  type Session,
} from '@autologger/contract';
import { FileTextIcon, TriangleAlertIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { qk, useOpMutation, useTranscript } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { NativeSelect } from '@/components/NativeSelect';
import { fmtSec } from '@/lib/timecode';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/shared/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/shared/components/ui/radio-group';
import { Dialog, DialogActions } from '@/shared/ui/Dialog';
import { useWorkspace } from './context';

type Format = 'srt' | 'vtt' | 'json';
type Mode = 'replace' | 'append';
type Result = OpOutputs['transcript.import'];

const SESSION = 'session';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The format from the file name, else from the content (WebVTT files start with WEBVTT). */
export function transcriptFormat(name: string, text: string): Format | null {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'srt' || ext === 'vtt' || ext === 'json') return ext;
  const head = text.trimStart();
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (head.startsWith('[')) return 'json';
  if (/^\d+\s*\r?\n\s*[\d:.,]+\s*-->/.test(head)) return 'srt';
  return null;
}

/** "Recording 2 · interview.mp3 · 0:10:00–0:55:00" */
export function recordingLabel(s: AudioSegment): string {
  const name =
    s.fileName ??
    (s.origin === 'youtube' ? 'YouTube audio' : s.origin === 'recorded' ? 'Recorded' : 'File');
  const span =
    s.durationSec != null
      ? `${fmtSec(s.startSec)}–${fmtSec(s.startSec + s.durationSec)}`
      : `from ${fmtSec(s.startSec)}`;
  return `Recording ${s.ordinal} · ${name} · ${span}`;
}

export function TranscriptImportDialog({
  session,
  segments,
  onClose,
}: {
  session: Session;
  /** The session's recordings (media.list); those still uploading can't take a transcript. */
  segments: AudioSegment[] | undefined;
  onClose: () => void;
}) {
  const ids = useId();
  const { setTab } = useWorkspace();
  const fileRef = useRef<HTMLInputElement>(null);
  const transcript = useTranscript(session.id);
  const [file, setFile] = useState<{ name: string; text: string; format: Format } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [target, setTarget] = useState<string>(SESSION);
  const [mode, setMode] = useState<Mode | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const imp = useOpMutation('transcript.import', {
    invalidate: () => [
      qk.transcript(session.id),
      qk.media(session.id),
      qk.session(session.id),
      qk.changesAll(session.id),
    ],
  });

  const recordings = (segments ?? []).filter((s) => s.status !== 'uploading');
  const audioSegmentId = target === SESSION ? undefined : target;
  const recording = recordings.find((s) => s.id === audioSegmentId);
  // What replace deletes: with a recording only its segments, otherwise the whole transcript.
  const existing = (transcript.data ?? []).filter(
    (s) => !audioSegmentId || s.audioSegmentId === audioSegmentId,
  ).length;
  // Nothing to lose: replace is the natural choice. Otherwise the operator must pick.
  const chosenMode: Mode | null = mode ?? (transcript.data && existing === 0 ? 'replace' : null);

  const onFile = async (f: File) => {
    setResult(null);
    imp.reset();
    setFile(null);
    setFileError(null);
    if (f.size > MAX_TRANSCRIPT_IMPORT_CHARS * 4) {
      setFileError('This file is too large to import (up to 5,000,000 characters).');
      return;
    }
    const text = await f.text();
    if (text.length > MAX_TRANSCRIPT_IMPORT_CHARS) {
      setFileError(
        `This file has ${text.length.toLocaleString()} characters; up to 5,000,000 can be imported.`,
      );
      return;
    }
    if (!text.trim()) {
      setFileError('This file is empty.');
      return;
    }
    const format = transcriptFormat(f.name, text);
    if (!format) {
      setFileError('Choose an .srt, .vtt or .json transcript file.');
      return;
    }
    setFile({ name: f.name, text, format });
  };

  const submit = () => {
    if (!file || !chosenMode || imp.isPending) return;
    // Keep the choice shown once the import adds lines (the default depends on the line count).
    setMode(chosenMode);
    setResult(null);
    imp.mutate(
      {
        sessionId: session.id,
        audioSegmentId,
        format: file.format,
        content: file.text,
        mode: chosenMode,
      },
      { onSuccess: (r) => setResult(r) },
    );
  };

  const targetName = recording ? `Recording ${recording.ordinal}` : 'the session';

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !imp.isPending && onClose()}
      title="Import transcript"
      description={session.title}
      className="md:max-w-lg"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="m-0 text-sm text-si-muted">
          Load a transcript you already have, such as subtitles from an editor, instead of
          transcribing the audio: an SRT or WebVTT file, or JSON lines with startSec, endSec,
          speaker and text. Speakers come from WebVTT voice tags or a label such as{' '}
          <code>Dana:</code> at the start of a cue.
        </p>

        <Field>
          <FieldLabel id={`${ids}-file`}>Transcript file</FieldLabel>
          <div className="flex min-w-0 items-center gap-2">
            <Button
              aria-describedby={`${ids}-file ${ids}-file-name`}
              type="button"
              variant="outline"
              disabled={imp.isPending}
              onClick={() => fileRef.current?.click()}
            >
              <FileTextIcon aria-hidden="true" />
              {file ? 'Choose another…' : 'Choose file…'}
            </Button>
            <span
              id={`${ids}-file-name`}
              className="min-w-0 flex-1 truncate text-sm text-si-muted"
              title={file?.name}
            >
              {file ? `${file.name} (${file.format.toUpperCase()})` : 'No file chosen'}
            </span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".srt,.vtt,.json,text/vtt,application/x-subrip,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onFile(f);
            }}
          />
          {fileError && (
            <FieldDescription className="text-si-danger" role="alert">
              {fileError}
            </FieldDescription>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor={`${ids}-target`}>Import into</FieldLabel>
          <NativeSelect
            id={`${ids}-target`}
            value={target}
            disabled={imp.isPending}
            onChange={(e) => {
              setTarget(e.target.value);
              setMode(null);
              setResult(null);
            }}
          >
            <option value={SESSION}>Whole session</option>
            {recordings.map((s) => (
              <option key={s.id} value={s.id}>
                {recordingLabel(s)}
              </option>
            ))}
          </NativeSelect>
          <FieldDescription>
            {recording
              ? `File times count from the start of this recording (${fmtSec(recording.startSec)} into the session); it is marked transcribed.`
              : 'File times count from the start of the session.'}
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel id={`${ids}-mode`}>Existing transcript</FieldLabel>
          <RadioGroup
            aria-labelledby={`${ids}-mode`}
            value={chosenMode}
            onValueChange={(v) => setMode(v as Mode)}
            disabled={imp.isPending}
            className="flex flex-wrap gap-4"
          >
            {(['replace', 'append'] as const).map((m) => (
              <span key={m} className="flex items-center gap-2">
                <RadioGroupItem id={`${ids}-${m}`} value={m} />
                <label htmlFor={`${ids}-${m}`} className="text-sm text-si-fg">
                  {m === 'replace' ? 'Replace' : 'Append'}
                </label>
              </span>
            ))}
          </RadioGroup>
          <FieldDescription hidden={!!result}>
            {transcript.isPending
              ? 'Loading the transcript…'
              : existing === 0
                ? `${targetName === 'the session' ? 'The session' : targetName} has no transcript yet.`
                : chosenMode === 'append'
                  ? `Adds the file's lines and keeps the ${plural(existing, 'line')} already there (overlaps are not checked).`
                  : `${targetName === 'the session' ? 'The session' : targetName} has ${plural(existing, 'transcript line')}. Choose whether to replace or keep them.`}
          </FieldDescription>
        </Field>

        {chosenMode === 'replace' && existing > 0 && !result && (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertDescription>
              Replace deletes the {plural(existing, 'line')} of{' '}
              {recording ? `${targetName}'s transcript` : 'the whole session transcript'}, including
              manual corrections and speaker renames, before importing.
            </AlertDescription>
          </Alert>
        )}

        {imp.error && (
          <Alert variant="destructive" role="alert">
            <AlertTitle>
              {imp.error.code === 'conflict'
                ? 'A transcription is running'
                : imp.error.code === 'bad_request'
                  ? 'Could not read this file'
                  : 'Import failed'}
            </AlertTitle>
            <AlertDescription>
              {errorMessage(imp.error)}
              {imp.error.code === 'conflict' &&
                ' Wait until it finishes (the Transcript tab shows progress), then import.'}
            </AlertDescription>
          </Alert>
        )}

        {result && (
          <Alert role="status">
            <AlertTitle>
              Imported {plural(result.imported, 'line')}
              {result.removed > 0 && `, replaced ${plural(result.removed, 'line')}`}
            </AlertTitle>
            <AlertDescription>
              <p className="m-0">
                {fmtSec(result.startSec)}–{fmtSec(result.endSec)}
                {result.speakers.length > 0
                  ? ` · Speakers: ${result.speakers.join(', ')}`
                  : ' · No speaker labels'}
              </p>
              <p className="m-0">
                Undo the whole import from the{' '}
                <Button
                  variant="link"
                  size="inline"
                  className="text-si-fg hover:text-si-accent"
                  onClick={() => {
                    setTab('agents');
                    onClose();
                  }}
                >
                  Agents tab
                </Button>
                .
              </p>
            </AlertDescription>
          </Alert>
        )}

        <DialogActions>
          <Button type="button" variant="outline" disabled={imp.isPending} onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button type="submit" disabled={!file || !chosenMode || imp.isPending}>
              {imp.isPending ? 'Importing…' : 'Import'}
            </Button>
          )}
        </DialogActions>
      </form>
    </Dialog>
  );
}
