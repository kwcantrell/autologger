// A page's revisions, newest first. Choosing one shows a line diff from it to the current page and
// offers Restore (`wiki.restore`, which appends a new revision).

import type { WikiPage } from '@autologger/contract';
import { useState } from 'react';
import { useWikiRevisions } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/shared/components/ui/sheet';
import { Spinner } from '@/shared/components/ui/spinner';
import { cn } from '@/shared/lib/utils';
import { DiffFigure } from './wikiDiff';
import { fmtWhen, useWikiRestore } from './wikiShared';

const REVISION_ROW =
  'h-auto w-full min-w-0 shrink items-baseline justify-start gap-2 whitespace-normal rounded-ctl border-0 px-2 py-2 text-left text-sm font-normal transition-colors not-disabled:hover:bg-si-panel-2 not-disabled:hover:text-foreground';

interface Props {
  page: WikiPage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canWrite: boolean;
}

export function WikiHistorySheet({ page, open, onOpenChange, canWrite }: Props) {
  const revisions = useWikiRevisions(page.id, open);
  const restore = useWikiRestore();
  const [chosen, setChosen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [prev, setPrev] = useState({ open, pageId: page.id });
  if (prev.open !== open || prev.pageId !== page.id) {
    setPrev({ open, pageId: page.id });
    setChosen(null);
    setError(null);
  }

  const rows = revisions.data ?? [];
  const rev = rows.find((r) => r.revision === chosen) ?? null;
  const isCurrent = chosen === page.revision;

  const doRestore = (n: number) => {
    setError(null);
    restore.mutate(
      { pageId: page.id, revision: n },
      {
        onSuccess: () => {
          showToast(`Restored r${n}.`);
          onOpenChange(false);
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-3 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>History</SheetTitle>
          <SheetDescription>
            {page.title}, now at r{page.revision}. Choose a revision to compare it with the current
            page.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4 pb-6">
          {revisions.isPending ? (
            <div role="status" className="flex items-center gap-2 text-sm text-si-muted">
              <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading history…
            </div>
          ) : revisions.isError ? (
            <div role="alert" className="flex items-center gap-2 text-sm text-si-fg">
              <span>{errorMessage(revisions.error) || 'History could not be loaded.'}</span>
              <Button variant="link" size="xs" onClick={() => void revisions.refetch()}>
                Try again
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="m-0 text-sm text-si-muted">No revisions yet.</p>
          ) : (
            <ol className="m-0 flex list-none flex-col p-0">
              {rows.map((r) => (
                <li key={r.revision}>
                  <Button
                    variant="ghost"
                    data-revision={r.revision}
                    aria-pressed={chosen === r.revision}
                    onClick={() => setChosen(r.revision)}
                    className={cn(REVISION_ROW, chosen === r.revision && 'bg-si-panel-2')}
                  >
                    <span className="shrink-0 font-mono text-xs text-si-dim tabular-nums">
                      r{r.revision}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-si-fg">
                      {r.author?.name ?? 'Unknown'}
                    </span>
                    {r.via === 'mcp' && (
                      <Badge variant="outline" className="shrink-0 self-center">
                        agent
                      </Badge>
                    )}
                    <time dateTime={r.at} className="shrink-0 text-xs text-si-dim">
                      {fmtWhen(r.at)}
                    </time>
                  </Button>
                </li>
              ))}
            </ol>
          )}

          {chosen != null && (
            <section aria-label={`Revision r${chosen}`} className="flex flex-col gap-3">
              <h3 className="m-0 text-sm font-semibold text-si-fg">r{chosen} → current page</h3>
              {isCurrent ? (
                <p className="m-0 text-xs text-si-muted">This is the current revision.</p>
              ) : rev ? (
                <>
                  {rev.title !== page.title && (
                    <p className="m-0 text-xs text-si-muted">
                      Title then: <span className="text-si-fg">{rev.title}</span>
                    </p>
                  )}
                  <DiffFigure
                    from={rev.bodyMd}
                    to={page.bodyMd}
                    label={`Changes from r${rev.revision} to the current page`}
                  />
                  {canWrite && (
                    <Button
                      size="sm"
                      className="self-start"
                      disabled={restore.isPending}
                      onClick={() => doRestore(rev.revision)}
                    >
                      {restore.isPending && <Spinner role="presentation" aria-hidden="true" />}
                      Restore r{rev.revision}
                    </Button>
                  )}
                </>
              ) : null}
              {error && (
                <p role="alert" className="m-0 text-sm text-si-danger">
                  {error}
                </p>
              )}
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
