// Import a whole YouTube playlist into a show (media.importPlaylist): preview with dryRun first,
// then create one session per video. Downloads and transcription run as background jobs, which
// each session's Audio menu shows.

import type { PlaylistImport, Show } from '@autologger/contract';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link } from 'wouter';
import { qk, useCapabilities, useOpMutation } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { fmtSec } from '@/lib/timecode';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/shared/components/ui/toggle-group';
import { DialogActions } from '@/shared/ui/Dialog';

type Order = 'playlist' | 'reverse';

const SKIP_REASON: Record<PlaylistImport['skipped'][number]['reason'], string> = {
  already_imported: 'Already in the show',
  unavailable: 'Private or deleted',
};

export function PlaylistImportForm({
  show,
  onClose,
}: {
  show: Show | undefined;
  onClose: () => void;
}) {
  const caps = useCapabilities().data;
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [order, setOrder] = useState<Order>('playlist');
  const [template, setTemplate] = useState('');
  // The preview (dryRun) or the finished import, with the inputs it was made for.
  const [result, setResult] = useState<{ key: string; data: PlaylistImport } | null>(null);
  const run = useOpMutation('media.importPlaylist');
  // Editing an input drops a stale error; the preview is kept per input set (see `current`).
  const edit = (apply: () => void) => {
    run.reset();
    apply();
  };

  const input = {
    showId: show?.id ?? '',
    url: url.trim(),
    order,
    ...(template.trim() ? { titleTemplate: template.trim() } : {}),
  };
  const key = JSON.stringify(input);
  const current = result?.key === key ? result.data : null;
  const imported = current && !current.dryRun ? current : null;
  const toCreate = current?.dryRun ? current.created.length : 0;

  const unavailable =
    caps && !caps.youtube
      ? caps.storage
        ? "YouTube import isn't enabled on this server (YOUTUBE_IMPORT)."
        : "YouTube import isn't available: audio storage isn't configured on this server."
      : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!show || !input.url || unavailable || run.isPending) return;
    if (imported) return onClose();
    const dryRun = !current;
    run.mutate(
      { ...input, dryRun },
      {
        onSuccess: (data) => {
          setResult({ key, data });
          if (dryRun) return;
          void qc.invalidateQueries({ queryKey: qk.sessionsAll });
          void qc.invalidateQueries({ queryKey: qk.shows });
          showToast(
            `Created ${data.created.length} session${data.created.length === 1 ? '' : 's'}. Downloads and transcription run in the background.`,
          );
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {unavailable && (
        <Alert>
          <AlertDescription>{unavailable}</AlertDescription>
        </Alert>
      )}
      <Field>
        <FieldLabel htmlFor="pl-url">Playlist link</FieldLabel>
        <Input
          id="pl-url"
          type="url"
          required
          autoComplete="off"
          maxLength={2048}
          disabled={!!unavailable || !!imported}
          placeholder="https://www.youtube.com/playlist?list=…"
          value={url}
          onChange={(e) => edit(() => setUrl(e.target.value))}
        />
        <FieldDescription>
          One new session per video. Videos already in the show, and private or deleted ones, are
          skipped, so importing the same playlist later adds only new videos.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel id="pl-order-label">Episode order</FieldLabel>
        <ToggleGroup
          variant="outline"
          aria-labelledby="pl-order-label"
          disabled={!!unavailable || !!imported}
          value={[order]}
          onValueChange={([v]) => {
            if (v === 'playlist' || v === 'reverse') edit(() => setOrder(v));
          }}
        >
          <ToggleGroupItem value="playlist">Playlist order</ToggleGroupItem>
          <ToggleGroupItem value="reverse">Reverse</ToggleGroupItem>
        </ToggleGroup>
        <FieldDescription>
          Episode numbers continue from the show’s next episode ({show?.nextEpisode ?? '—'}). Choose
          Reverse when the playlist lists the newest video first.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="pl-template">Session title (optional)</FieldLabel>
        <Input
          id="pl-template"
          autoComplete="off"
          maxLength={200}
          disabled={!!unavailable || !!imported}
          placeholder="{title}"
          value={template}
          onChange={(e) => edit(() => setTemplate(e.target.value))}
        />
        <FieldDescription>
          Use {'{title}'} for the video title and {'{episode}'} for the episode number. Left empty,
          sessions take the video title.
        </FieldDescription>
      </Field>

      {current && <PlaylistResult data={current} onOpenSession={onClose} />}

      {run.error && (
        <Alert variant="destructive">
          <AlertDescription>
            {current ? 'The import did not start.' : 'Could not preview the playlist.'}{' '}
            {errorMessage(run.error)}
          </AlertDescription>
        </Alert>
      )}

      <DialogActions>
        {imported ? (
          <Button type="submit">Done</Button>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            {current && (
              <Button type="button" variant="outline" onClick={() => setResult(null)}>
                Preview again
              </Button>
            )}
            <Button
              type="submit"
              disabled={
                !show || !input.url || !!unavailable || run.isPending || (!!current && !toCreate)
              }
            >
              {run.isPending
                ? current
                  ? 'Importing…'
                  : 'Reading playlist…'
                : current
                  ? toCreate
                    ? `Import ${toCreate} video${toCreate === 1 ? '' : 's'}`
                    : 'Nothing new to import'
                  : 'Preview'}
            </Button>
          </>
        )}
      </DialogActions>
    </form>
  );
}

function PlaylistResult({
  data,
  onOpenSession,
}: {
  data: PlaylistImport;
  onOpenSession: () => void;
}) {
  const n = data.created.length;
  return (
    <section aria-live="polite" className="flex min-w-0 flex-col gap-3">
      <p className="m-0 text-sm">
        {data.playlistTitle ? <strong>{data.playlistTitle}</strong> : 'This playlist'}
        {data.dryRun
          ? n
            ? ` · ${n} new session${n === 1 ? '' : 's'} will be created.`
            : ' · nothing new to import.'
          : ` · ${n} session${n === 1 ? '' : 's'} created. Each session’s Audio menu shows its download and transcription.`}
      </p>
      {n > 0 && (
        <ResultList label={data.dryRun ? 'Will be created' : 'Created'}>
          {data.created.map((c) => (
            <li key={c.videoId} className={ROW}>
              <span className="w-10 shrink-0 font-tc text-xs tabular-nums text-si-muted">
                #{c.episode}
              </span>
              <span className="min-w-0 flex-1 truncate" title={c.title}>
                {c.sessionId ? (
                  <Link
                    className={LINK}
                    onClick={onOpenSession}
                    href={`/sessions/${encodeURIComponent(c.sessionId)}`}
                  >
                    {c.title}
                  </Link>
                ) : (
                  c.title
                )}
              </span>
              <span className="shrink-0 font-tc text-xs tabular-nums text-si-muted">
                {c.durationSec != null ? fmtSec(c.durationSec) : '—'}
              </span>
            </li>
          ))}
        </ResultList>
      )}
      {data.skipped.length > 0 && (
        <ResultList label={`Skipped (${data.skipped.length})`}>
          {data.skipped.map((s) => (
            <li key={s.videoId} className={ROW}>
              <span className="min-w-0 flex-1 truncate" title={s.title}>
                {s.sessionId ? (
                  <Link
                    className={LINK}
                    onClick={onOpenSession}
                    href={`/sessions/${encodeURIComponent(s.sessionId)}`}
                  >
                    {s.title || s.videoId}
                  </Link>
                ) : (
                  s.title || s.videoId
                )}
              </span>
              <Badge variant="outline" className="shrink-0">
                {SKIP_REASON[s.reason]}
              </Badge>
            </li>
          ))}
        </ResultList>
      )}
    </section>
  );
}

const ROW = 'flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm';
const LINK = 'text-si-fg underline underline-offset-2 hover:text-si-accent';

function ResultList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="m-0 font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim">
        {label}
      </h3>
      <ul className="m-0 flex max-h-52 list-none flex-col overflow-y-auto rounded-ctl border border-si-line p-0 divide-y divide-si-line">
        {children}
      </ul>
    </div>
  );
}
