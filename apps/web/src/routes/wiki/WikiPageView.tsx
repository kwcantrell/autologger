// `/wiki/:pageId`: one wiki page. Read mode renders the body (with [[Title]] links resolved against
// the page's show) and its backlinks; Edit saves through `wiki.upsert` with the pageId; History is
// a right sheet with diffs and Restore; Delete confirms first. Write actions follow the show's
// access; a page of a show other than the active one offers the switch.

import type { WikiPage } from '@autologger/contract';
import { ArrowLeftIcon, HistoryIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useLocation, useSearch as useLocationSearch } from 'wouter';
import { useWikiBacklinks, useWikiPage } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { selectShow, useActive } from '@/app/useActive';
import { PageFrame } from '@/components/RouteState';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Spinner } from '@/shared/components/ui/spinner';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { type WikiDraft, WikiEditor } from './WikiEditor';
import { WikiHistorySheet } from './WikiHistorySheet';
import { WikiMarkdown } from './WikiMarkdown';
import {
  fmtWhen,
  useWikiDelete,
  useWikiResolver,
  useWikiUpsert,
  WIKI_KIND_LABEL,
  wikiHref,
} from './wikiShared';

const draftOf = (p: WikiPage): WikiDraft => ({
  title: p.title,
  body: p.bodyMd,
  aliases: p.aliases,
});

function Frame({ children }: { children: ReactNode }) {
  return (
    <PageFrame className="max-md:px-3">
      <div data-slot="wiki-page" className="contents">
        <Link
          href="/wiki"
          className="inline-flex items-center gap-1 self-start text-xs font-semibold text-si-dim no-underline hover:text-si-fg"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-3.5" /> Wiki
        </Link>
        {children}
      </div>
    </PageFrame>
  );
}

export function WikiPageView({ pageId }: { pageId: string }) {
  const { data: page, isPending, isError, error, refetch } = useWikiPage(pageId);

  if (isPending)
    return (
      <Frame>
        <div role="status" className="flex items-center gap-2 py-10 text-sm text-si-muted">
          <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading page…
        </div>
      </Frame>
    );
  if (isError || !page) {
    const missing = error?.code === 'not_found' || error?.code === 'forbidden';
    return (
      <Frame>
        <div role="alert" className="flex flex-col items-start gap-3 py-6 text-sm text-si-fg">
          <p className="m-0">
            {missing
              ? 'Page not found. It may be in a show you can’t open.'
              : errorMessage(error) || 'The page could not be loaded.'}
          </p>
          {!missing && (
            <Button variant="outline" onClick={() => void refetch()}>
              Try again
            </Button>
          )}
        </div>
      </Frame>
    );
  }
  // Keyed: another page starts with no edit or panel open.
  return <PageBody key={page.id} page={page} />;
}

function PageBody({ page }: { page: WikiPage }) {
  const [, navigate] = useLocation();
  const search = useLocationSearch();
  const { show: activeShow, allShows } = useActive();
  const pageShow = allShows.find((s) => s.id === page.showId) ?? null;
  const canWrite = pageShow?.access === 'manage' || pageShow?.access === 'write';
  const otherShow = !!activeShow && activeShow.id !== page.showId;
  const isSession = page.kind === 'session';
  const { resolve } = useWikiResolver(page.showId);
  const upsert = useWikiUpsert();
  const del = useWikiDelete(page.showId);
  const { confirm, confirmElement } = useConfirm();
  const [history, setHistory] = useState(false);
  // `?edit=1` (a page just created) opens straight in edit mode.
  const [edit, setEdit] = useState<{ draft: WikiDraft; error: string | null } | null>(() =>
    new URLSearchParams(search).get('edit') === '1' && canWrite
      ? { draft: draftOf(page), error: null }
      : null,
  );

  const readOnlyWhy = !pageShow
    ? 'Your access to this show is still loading.'
    : `You have read-only access to ${pageShow.name}. Ask a team admin for write access to edit its wiki.`;

  const leaveEdit = () => {
    setEdit(null);
    if (search) navigate(wikiHref(page.id), { replace: true });
  };

  const save = () => {
    if (!edit) return;
    const title = edit.draft.title.trim();
    if (!title) {
      setEdit({ ...edit, error: 'A page needs a title.' });
      return;
    }
    upsert.mutate(
      {
        showId: page.showId,
        pageId: page.id,
        kind: page.kind,
        title,
        bodyMd: edit.draft.body,
        ...(isSession ? {} : { aliases: edit.draft.aliases }),
        ...(page.sessionId ? { sessionId: page.sessionId } : {}),
      },
      {
        onSuccess: () => leaveEdit(),
        onError: (e) =>
          setEdit((s) => s && { ...s, error: errorMessage(e) || 'The page was not saved.' }),
      },
    );
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: 'Delete this page?',
      message: `“${page.title}” leaves the wiki for everyone and links to it will show as missing. Its revision history is kept, so the deletion can be undone from the change log.`,
      confirmLabel: 'Delete page',
      danger: true,
    });
    if (!ok) return;
    del.mutate(
      { pageId: page.id },
      {
        onSuccess: () => {
          showToast(`Deleted “${page.title}”.`);
          navigate('/wiki');
        },
        onError: (e) => showToast(`Couldn't delete the page: ${errorMessage(e)}`, true),
      },
    );
  };

  return (
    <Frame>
      {otherShow && (
        <Alert>
          <AlertTitle>This page belongs to {pageShow?.name ?? 'another show'}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>It isn’t in your active show, so its links point into that show’s wiki.</span>
            {pageShow && (
              <Button size="sm" variant="outline" onClick={() => selectShow(pageShow)}>
                Switch to {pageShow.name}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{WIKI_KIND_LABEL[page.kind]}</Badge>
        </div>
        <h1 className="m-0 text-[1.35rem] font-semibold break-words text-si-fg">{page.title}</h1>
        {page.aliases.length > 0 && (
          <ul aria-label="Aliases" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {page.aliases.map((a) => (
              <li key={a}>
                <Badge variant="outline" className="normal-case tracking-normal">
                  {a}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 text-xs text-si-dim">
          Last changed by <span className="text-si-muted">{page.updatedBy?.name ?? 'someone'}</span>
          , <time dateTime={page.updatedAt}>{fmtWhen(page.updatedAt)}</time> · r{page.revision}
          {page.sessionId && (
            <>
              {' · '}
              <Link
                href={`/sessions/${encodeURIComponent(page.sessionId)}`}
                className="text-si-muted underline underline-offset-2 hover:text-si-fg"
              >
                Open session
              </Link>
            </>
          )}
        </p>
      </header>

      {!edit && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!canWrite}
              onClick={() => setEdit({ draft: draftOf(page), error: null })}
            >
              <PencilIcon aria-hidden="true" /> Edit
            </Button>
            <Button size="sm" variant="outline" onClick={() => setHistory(true)}>
              <HistoryIcon aria-hidden="true" /> History
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-si-danger"
              disabled={!canWrite || del.isPending}
              onClick={() => void onDelete()}
            >
              <Trash2Icon aria-hidden="true" /> Delete
            </Button>
          </div>
          {!canWrite && <p className="m-0 text-xs text-si-dim">{readOnlyWhy}</p>}
        </div>
      )}

      {edit ? (
        <section aria-label="Edit page" className="flex flex-col gap-4">
          <WikiEditor
            draft={edit.draft}
            onChange={(draft) => setEdit({ draft, error: null })}
            showAliases={!isSession}
            resolve={resolve}
          />
          {edit.error && (
            <p role="alert" className="m-0 text-sm text-si-danger">
              {edit.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={leaveEdit} disabled={upsert.isPending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={upsert.isPending}>
              {upsert.isPending && <Spinner role="presentation" aria-hidden="true" />}
              Save
            </Button>
          </div>
        </section>
      ) : page.bodyMd.trim() ? (
        <WikiMarkdown body={page.bodyMd} resolve={resolve} />
      ) : (
        <p className="m-0 text-sm text-si-muted">This page is empty.</p>
      )}

      {!edit && page.backlinks.length > 0 && <Backlinks page={page} />}

      <WikiHistorySheet page={page} open={history} onOpenChange={setHistory} canWrite={canWrite} />
      {confirmElement}
    </Frame>
  );
}

/** "Linked from": the first 50 backlinks from wiki.get; "and N more" loads all (wiki.list linksTo). */
function Backlinks({ page }: { page: WikiPage }) {
  const [showAll, setShowAll] = useState(false);
  const all = useWikiBacklinks(page.showId, page.id, showAll);
  const list = showAll && all.data ? all.data : page.backlinks;
  const hidden = page.backlinkCount - list.length;
  return (
    <section
      aria-labelledby="wiki-backlinks"
      className="flex flex-col gap-1 border-t border-si-line pt-4"
    >
      <h2
        id="wiki-backlinks"
        className="m-0 text-xs font-semibold tracking-wide text-si-dim uppercase"
      >
        Linked from
      </h2>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
        {list.map((b) => (
          <li key={b.id} className="flex items-baseline gap-1.5 text-sm">
            <Link
              href={wikiHref(b.id)}
              className="text-si-fg underline decoration-(--si-line-strong) underline-offset-2 hover:text-si-accent"
            >
              {b.title}
            </Link>
            <span className="text-xs text-si-dim">{WIKI_KIND_LABEL[b.kind]}</span>
          </li>
        ))}
        {hidden > 0 && (
          <li className="flex items-baseline gap-1.5 text-sm text-si-dim">
            {all.isError && <span role="alert">Couldn’t load the other {hidden}.</span>}
            <button
              type="button"
              disabled={all.isFetching}
              aria-busy={all.isFetching}
              onClick={() => (showAll ? void all.refetch() : setShowAll(true))}
              className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-sm text-si-dim underline decoration-(--si-line-strong) underline-offset-2 hover:text-si-fg disabled:cursor-default"
            >
              {all.isFetching && (
                <Spinner role="presentation" aria-hidden="true" className="size-3" />
              )}
              {all.isError ? 'Try again' : `and ${hidden} more`}
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}
