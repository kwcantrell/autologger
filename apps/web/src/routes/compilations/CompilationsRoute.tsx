// `/compilations`: video compilations of the active show. Agents create them over MCP and people
// with "Make video" on a wiki page's citations or a session's topics (MakeVideoDialog), both through
// compilations.create, from ranges of YouTube-imported sessions; the worker builds one MP4 each.
// Here people watch, download, retry (failed builds) and delete them. Updates arrive as show-socket hints (liveShow.ts).

import type { Compilation } from '@autologger/contract';
import {
  useCapabilities,
  useCompilations,
  useDeleteCompilation,
  useRetryCompilation,
} from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { PageFrame, RouteLoadingState } from '@/components/RouteState';
import { showToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/shared/components/ui/empty';
import { Spinner } from '@/shared/components/ui/spinner';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { CompilationCard } from './CompilationCard';

function CompilationList({ showId, canWrite }: { showId: string; canWrite: boolean }) {
  const { data, isPending, isError, error, refetch } = useCompilations(showId);
  const del = useDeleteCompilation(showId);
  const retry = useRetryCompilation();
  const { confirm, confirmElement } = useConfirm();

  const onDelete = async (c: Compilation) => {
    const ok = await confirm({
      title: 'Delete this compilation?',
      message: `“${c.title}” and its video are deleted for everyone. This cannot be undone; the sessions are not affected.`,
      confirmLabel: 'Delete compilation',
      danger: true,
    });
    if (!ok) return;
    del.mutate(
      { compilationId: c.id },
      {
        onSuccess: () => showToast(`Deleted “${c.title}”.`),
        onError: (e) => showToast(`Couldn't delete the compilation: ${errorMessage(e)}`, true),
      },
    );
  };

  if (isError)
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center text-sm">
        <p className="m-0 text-si-fg">{errorMessage(error) || 'Could not load compilations.'}</p>
        <Button variant="outline" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  if (isPending)
    return (
      <div
        role="status"
        className="flex items-center justify-center gap-2 py-10 text-sm text-si-muted"
      >
        <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading compilations…
      </div>
    );
  if (data.length === 0)
    return (
      <div className="flex flex-col items-center gap-1 py-10 text-center">
        <p className="m-0 text-sm text-si-muted">No compilations yet.</p>
        <p className="m-0 max-w-[30rem] text-xs text-si-dim">
          Use “Make video” on a wiki page with citations or on a session’s Topics tab, or ask an
          agent connected over MCP — for example “make a video of every time we talked about the
          dog”. Only sessions imported from YouTube can be compiled.
        </p>
      </div>
    );
  return (
    <>
      <ul aria-label="Compilations" className="m-0 flex list-none flex-col gap-3 p-0">
        {data.map((c) => (
          <CompilationCard
            key={c.id}
            c={c}
            canWrite={canWrite}
            deleting={del.isPending && del.variables?.compilationId === c.id}
            onDelete={() => void onDelete(c)}
            retrying={retry.isPending && retry.variables?.compilationId === c.id}
            onRetry={() =>
              retry.mutate(
                { compilationId: c.id },
                {
                  onSuccess: () => showToast(`“${c.title}” queued again.`),
                  onError: (e) =>
                    showToast(`Couldn't retry the compilation: ${errorMessage(e)}`, true),
                },
              )
            }
          />
        ))}
      </ul>
      {confirmElement}
    </>
  );
}

export function CompilationsRoute() {
  const { show, showsLoading, canWriteShow } = useActive();
  const storage = useCapabilities().data?.storage;

  if (showsLoading) return <RouteLoadingState label="Loading compilations" />;

  return (
    <PageFrame className="max-md:px-3">
      <div data-slot="compilations-route" className="contents">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="m-0 text-[1.35rem] font-semibold text-si-fg">Compilations</h1>
          {show && <p className="m-0 truncate text-sm text-si-muted">{show.name}</p>}
        </div>
        {!show ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No show chosen</EmptyTitle>
              <EmptyDescription>
                Choose a show in the top bar to see its compilations.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : storage === false ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Media storage is not configured</EmptyTitle>
              <EmptyDescription>
                Compilations need S3 storage on this server (S3_BUCKET and credentials).
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <CompilationList showId={show.id} canWrite={canWriteShow} />
        )}
      </div>
    </PageFrame>
  );
}
