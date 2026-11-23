// What the page editor shows when a save was refused because the page changed while it was open
// (wiki.upsert with baseRevision answered conflict): load the latest version (the user's text stays
// available to copy, WikiKeptText) or overwrite it with the draft.

import type { WikiPage } from '@autologger/contract';
import { CopyIcon, RefreshCwIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { useId } from 'react';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Textarea } from '@/shared/components/ui/textarea';

function copyText(text: string) {
  navigator.clipboard.writeText(text).then(
    () => showToast('Your text is on the clipboard.'),
    () => showToast('Could not copy to the clipboard.', true),
  );
}

export function WikiConflictNotice({
  message,
  latest,
  text,
  busy,
  onLoadLatest,
  onOverwrite,
}: {
  /** The server's conflict message: the current revision and who changed it. */
  message: string;
  latest: Pick<WikiPage, 'revision'>;
  /** The draft body, for Copy. */
  text: string;
  busy: boolean;
  onLoadLatest: () => void;
  onOverwrite: () => void;
}) {
  return (
    <Alert variant="destructive" data-slot="wiki-conflict">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>This page changed while you were editing</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p className="m-0">{message} Your edits are still in the editor.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => copyText(text)}>
            <CopyIcon aria-hidden="true" /> Copy my text
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={onLoadLatest}>
            <RefreshCwIcon aria-hidden="true" /> Load latest version
          </Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={onOverwrite}>
            Overwrite with my version
          </Button>
        </div>
        <p className="m-0 text-xs">
          Loading the latest version keeps your text above the editor to copy from. Overwriting
          replaces r{latest.revision}; it stays in History.
        </p>
      </AlertDescription>
    </Alert>
  );
}

/** The user's text from before "Load latest version", read-only, to copy into the new draft. */
export function WikiKeptText({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      data-slot="wiki-kept-text"
      className="flex flex-col gap-2 rounded-ctl border border-si-line bg-si-panel-2 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="m-0 text-sm font-semibold text-si-fg">
          Your unsaved text
        </h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => copyText(text)}>
            <CopyIcon aria-hidden="true" /> Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            <XIcon aria-hidden="true" /> Dismiss
          </Button>
        </div>
      </div>
      <p className="m-0 text-xs text-si-dim">
        The editor below now holds the latest version. Copy what you still need from here.
      </p>
      <Textarea
        aria-label="Your unsaved text"
        readOnly
        value={text}
        className="max-h-60 min-h-24 font-mono text-[0.85rem] leading-relaxed"
      />
    </section>
  );
}
