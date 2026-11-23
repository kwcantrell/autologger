// Import a whole YouTube playlist into a show (media.importPlaylist): preview with dryRun first,
// then create one session per video. Downloads and transcription run as background jobs, which
// each session's Audio menu shows.

import type { PlaylistImport, Show } from '@autologger/contract';
import { type FormEvent, useEffect, useState } from 'react';
import { qk, useCapabilities, useOpMutation } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { isYoutubeAuthError, YoutubeAuthHelp } from '@/app/YoutubeAuthHelp';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/shared/components/ui/toggle-group';
import { DialogActions } from '@/shared/ui/Dialog';
import { PlaylistResult } from './PlaylistResult';

type Order = 'playlist' | 'reverse';

export function PlaylistImportForm({
  show,
  onClose,
  onImportingChange,
}: {
  show: Show | undefined;
  onClose: () => void;
  /** True while a real (non-dry) import is in flight: the dialog should stay open. */
  onImportingChange: (importing: boolean) => void;
}) {
  const caps = useCapabilities().data;
  const [url, setUrl] = useState('');
  const [order, setOrder] = useState<Order>('playlist');
  const [template, setTemplate] = useState('');
  // The preview (dryRun) or the finished import, with the inputs it was made for.
  const [result, setResult] = useState<{ key: string; data: PlaylistImport } | null>(null);
  // Refresh and toast in the hook, not per call: they must run even if the form has unmounted.
  const run = useOpMutation('media.importPlaylist', {
    invalidate: (d) => (d.dryRun ? [] : [qk.sessionsAll, qk.shows, qk.showJobsAll]),
    onSuccess: (d) => {
      if (d.dryRun) return;
      const n = d.created.length;
      showToast(
        `Created ${n} session${n === 1 ? '' : 's'}. Downloads and transcription run in the background.`,
      );
    },
  });
  const importing = run.isPending && run.variables?.dryRun === false;
  useEffect(() => onImportingChange(importing), [importing, onImportingChange]);
  // Editing an input drops the preview and any error: Import only runs on what was previewed.
  const edit = (apply: () => void) => {
    run.reset();
    setResult(null);
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
    run.mutate({ ...input, dryRun }, { onSuccess: (data) => setResult({ key, data }) });
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
            {isYoutubeAuthError(errorMessage(run.error)) && (
              <YoutubeAuthHelp onNavigate={onClose} />
            )}
          </AlertDescription>
        </Alert>
      )}

      <DialogActions>
        {imported ? (
          <Button type="submit">Done</Button>
        ) : (
          <>
            <Button type="button" variant="outline" disabled={importing} onClick={onClose}>
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
