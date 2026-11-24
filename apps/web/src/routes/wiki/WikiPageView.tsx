// `/wiki/:pageId`: one wiki page. Read mode renders the body (with [[Title]] links resolved against
// the page's show) and its backlinks; Edit saves through `wiki.upsert` with the pageId and the
// revision the edit started from, so a page changed meanwhile (another tab, an agent) answers
// conflict and the editor offers to load the latest or overwrite it instead; History is
// a right sheet with diffs and Restore; Delete confirms first. Write actions follow the show's
// access (team wiki pages: every team member); a page of a show other than the active one offers
// the switch. Show pages can move to the team wiki and team pages into a show (wiki.move).

import type { WikiPage } from '@autologger/contract';
import {
  ArrowLeftIcon,
  ArrowRightLeftIcon,
  FilmIcon,
  HistoryIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link, useLocation, useSearch as useLocationSearch } from 'wouter';
import {
  useSessions,
  useWikiBacklinks,
  useWikiPage,
  type WikiScope,
  wikiScopeOf,
} from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { selectShow, useActive } from '@/app/useActive';
import { PageFrame } from '@/components/RouteState';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Spinner } from '@/shared/components/ui/spinner';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { LoadErrorAlert } from '@/shared/ui/LoadErrorAlert';
import { Tooltip } from '@/shared/ui/Tooltip';
import { citationCandidates, planClips } from '../compilations/clipPlan';
import { MakeVideoDialog, useMakeVideoBlocked } from '../compilations/MakeVideoDialog';
import { MoveWikiPageDialog } from './MoveWikiPageDialog';
import { WikiConflictNotice, WikiKeptText } from './WikiConflictNotice';
import { type WikiDraft, WikiEditor } from './WikiEditor';
import { WikiHistorySheet } from './WikiHistorySheet';
import { WikiMarkdown } from './WikiMarkdown';
import { BacklinksSection, WikiPageHeader } from './WikiPageParts';
import {
  teamWikiHref,
  useSessionTitles,
  useWikiDelete,
  useWikiResolver,
  useWikiUpsert,
  wikiHref,
  wikiIndexHref,
} from './wikiShared';

const draftOf = (p: WikiPage): WikiDraft => ({
  title: p.title,
  body: p.bodyMd,
  aliases: p.aliases,
});

interface EditState {
  draft: WikiDraft;
  error: string | null;
  /** The revision the draft started from, sent as baseRevision. */
  base: number;
  /** The save was refused because the page moved on past `base` (the server's message). */
  conflict: string | null;
  /** The text the user had before loading the latest version, kept to copy from. */
  kept: string | null;
}

const startEdit = (p: WikiPage, kept: string | null = null): EditState => ({
  draft: draftOf(p),
  error: null,
  base: p.revision,
  conflict: null,
  kept,
});

function Frame({ children, scope }: { children: ReactNode; scope?: WikiScope }) {
  return (
    <PageFrame className="max-md:px-3">
      <div data-slot="wiki-page" className="contents">
        <Link
          href={wikiIndexHref(scope)}
          className="inline-flex items-center gap-1 self-start text-xs font-semibold text-si-dim no-underline hover:text-si-fg"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-3.5" />{' '}
          {scope?.teamId ? 'Team wiki' : 'Wiki'}
        </Link>
        {children}
      </div>
    </PageFrame>
  );
}

export function WikiPageView({ pageId }: { pageId: string }) {
  const { data: page, isPending, isError, error, refetch, isRefetching } = useWikiPage(pageId);

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
        {missing ? (
          <LoadErrorAlert title="Page not found" missing className="my-6">
            It may have been deleted, or it’s in a show you can’t open.
          </LoadErrorAlert>
        ) : (
          <LoadErrorAlert
            title="Couldn’t load the page"
            onRetry={() => void refetch()}
            retrying={isRefetching}
            className="my-6"
          >
            {errorMessage(error) || 'Check your connection and try again.'}
          </LoadErrorAlert>
        )}
      </Frame>
    );
  }
  // Keyed: another page starts with no edit or panel open.
  return <PageBody key={page.id} page={page} />;
}

function PageBody({ page }: { page: WikiPage }) {
  const [, navigate] = useLocation();
  const search = useLocationSearch();
  const { show: activeShow, allShows, teams } = useActive();
  const scope = useMemo(() => wikiScopeOf(page), [page]);
  const pageShow = allShows.find((s) => s.id === page.showId) ?? null;
  const team = teams.find((t) => t.id === (page.teamId ?? pageShow?.teamId)) ?? null;
  const isTeamPage = !page.showId;
  const canWrite = isTeamPage
    ? !!team
    : pageShow?.access === 'manage' || pageShow?.access === 'write';
  const otherShow = !isTeamPage && !!activeShow && activeShow.id !== page.showId;
  const isSession = page.kind === 'session';
  const { resolve } = useWikiResolver(scope);
  const sessionTitle = useSessionTitles(scope, page.bodyMd, page.sessionId);
  const upsert = useWikiUpsert();
  // The same cached wiki.get as the route: refetched to learn the latest revision on a conflict.
  const { refetch: refetchPage } = useWikiPage(page.id);
  const del = useWikiDelete(scope);
  const { confirm, confirmElement } = useConfirm();
  const [history, setHistory] = useState(false);
  const [makeVideo, setMakeVideo] = useState(false);
  const [moving, setMoving] = useState(false);
  // Recaps and pages tied to a session stay in their show.
  const canMove = canWrite && !!team && !isSession && !page.sessionId;
  const citations = useMemo(
    () => citationCandidates(page.bodyMd, page.sessionId),
    [page.bodyMd, page.sessionId],
  );
  // The same cached sessions.list the citation titles use. A compilation belongs to one show, so
  // team pages (citing any show) don't make videos.
  const citedSessions = useSessions(citations.length && page.showId ? page.showId : undefined);
  const noVideo =
    citedSessions.data && planClips(citations, citedSessions.data).clips.length === 0
      ? 'None of the cited sessions were imported from YouTube, so there is no video to cut.'
      : null;
  const videoBlocked = useMakeVideoBlocked(canWrite, pageShow?.name) ?? noVideo;
  // `?edit=1` (a page just created) opens straight in edit mode.
  const [edit, setEdit] = useState<EditState | null>(() =>
    new URLSearchParams(search).get('edit') === '1' && canWrite ? startEdit(page) : null,
  );

  const readOnlyWhy = isTeamPage
    ? 'Only members of this team can edit its wiki.'
    : !pageShow
      ? 'Your access to this show is still loading.'
      : `You have read-only access to ${pageShow.name}. Ask a team admin for write access to edit its wiki.`;

  const leaveEdit = () => {
    setEdit(null);
    if (search) navigate(wikiHref(page.id), { replace: true });
  };

  /** Save the draft over `base` (the revision it started from, or the latest one to overwrite). */
  const save = (base = edit?.base) => {
    if (!edit || base === undefined) return;
    const title = edit.draft.title.trim();
    if (!title) {
      setEdit({ ...edit, error: 'A page needs a title.' });
      return;
    }
    upsert.mutate(
      {
        ...(page.showId ? { showId: page.showId } : { teamId: page.teamId! }),
        pageId: page.id,
        kind: page.kind,
        title,
        bodyMd: edit.draft.body,
        ...(isSession ? {} : { aliases: edit.draft.aliases }),
        ...(page.sessionId ? { sessionId: page.sessionId } : {}),
        baseRevision: base,
      },
      {
        onSuccess: () => leaveEdit(),
        onError: async (e) => {
          // conflict is also a title clash; only a page that moved on is an edit conflict.
          if (e.code === 'conflict') {
            const latest = (await refetchPage()).data;
            if (latest && latest.revision !== base) {
              setEdit((s) => s && { ...s, error: null, conflict: e.message });
              return;
            }
          }
          setEdit((s) => s && { ...s, error: errorMessage(e) || 'The page was not saved.' });
        },
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
          navigate(wikiIndexHref(scope));
        },
        onError: (e) => showToast(`Couldn't delete the page: ${errorMessage(e)}`, true),
      },
    );
  };

  return (
    <Frame scope={scope}>
      {isTeamPage && team && (
        <p className="m-0 text-sm text-si-muted">
          Team wiki ·{' '}
          <Link href={teamWikiHref(team.id)} className="text-si-muted underline underline-offset-2">
            {team.name}
          </Link>{' '}
          — every show of the team links this page by title.
        </p>
      )}
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

      <WikiPageHeader page={page} />

      {!edit && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!canWrite} onClick={() => setEdit(startEdit(page))}>
              <PencilIcon aria-hidden="true" /> Edit
            </Button>
            <Button size="sm" variant="outline" onClick={() => setHistory(true)}>
              <HistoryIcon aria-hidden="true" /> History
            </Button>
            {canMove && (
              <Button size="sm" variant="outline" onClick={() => setMoving(true)}>
                <ArrowRightLeftIcon aria-hidden="true" />
                {isTeamPage ? 'Move to show…' : 'Move to team wiki'}
              </Button>
            )}
            {citations.length > 0 && !isTeamPage && (
              <Tooltip content={videoBlocked} disabled={!videoBlocked}>
                <span className="inline-flex">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!videoBlocked}
                    onClick={() => setMakeVideo(true)}
                  >
                    <FilmIcon aria-hidden="true" /> Make video
                  </Button>
                </span>
              </Tooltip>
            )}
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
          {canWrite && citations.length > 0 && videoBlocked && (
            <p className="m-0 text-xs text-si-dim">Make video: {videoBlocked}</p>
          )}
        </div>
      )}

      {edit ? (
        <section aria-label="Edit page" className="flex flex-col gap-4">
          {edit.kept !== null && (
            <WikiKeptText text={edit.kept} onDismiss={() => setEdit({ ...edit, kept: null })} />
          )}
          <WikiEditor
            draft={edit.draft}
            onChange={(draft) => setEdit({ ...edit, draft, error: null })}
            showAliases={!isSession}
            resolve={resolve}
            scope={scope}
            sessionId={page.sessionId}
          />
          {edit.error && (
            <p role="alert" className="m-0 text-sm text-si-danger">
              {edit.error}
            </p>
          )}
          {edit.conflict && (
            <WikiConflictNotice
              message={edit.conflict}
              latest={page}
              busy={upsert.isPending}
              text={edit.draft.body}
              onLoadLatest={() => setEdit(startEdit(page, edit.draft.body))}
              onOverwrite={() => save(page.revision)}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={leaveEdit} disabled={upsert.isPending}>
              Cancel
            </Button>
            <Button onClick={() => save()} disabled={upsert.isPending}>
              {upsert.isPending && <Spinner role="presentation" aria-hidden="true" />}
              Save
            </Button>
          </div>
        </section>
      ) : page.bodyMd.trim() ? (
        <WikiMarkdown
          body={page.bodyMd}
          resolve={resolve}
          sessionTitle={sessionTitle}
          sessionId={page.sessionId}
        />
      ) : (
        <p className="m-0 text-sm text-si-muted">This page is empty.</p>
      )}

      {!edit && page.backlinks.length > 0 && <Backlinks page={page} />}

      {canMove && team && (
        <MoveWikiPageDialog page={page} teamId={team.id} open={moving} onOpenChange={setMoving} />
      )}
      {citations.length > 0 && page.showId && (
        <MakeVideoDialog
          showId={page.showId}
          open={makeVideo}
          onOpenChange={setMakeVideo}
          defaultTitle={page.title}
          candidates={citations}
          sourceNoun="page’s citations"
          startTicked={true}
        />
      )}
      <WikiHistorySheet page={page} open={history} onOpenChange={setHistory} canWrite={canWrite} />
      {confirmElement}
    </Frame>
  );
}

/** "Linked from": the first 50 backlinks from wiki.get; "and N more" loads all (wiki.list linksTo). */
function Backlinks({ page }: { page: WikiPage }) {
  const [showAll, setShowAll] = useState(false);
  const { allShows } = useActive();
  // A team page is linked from team pages and from the pages of each of the team's shows.
  const scopes = useMemo<WikiScope[]>(
    () =>
      page.showId
        ? [{ showId: page.showId }]
        : [
            { teamId: page.teamId! },
            ...allShows.filter((s) => s.teamId === page.teamId).map((s) => ({ showId: s.id })),
          ],
    [page.showId, page.teamId, allShows],
  );
  const all = useWikiBacklinks(scopes, page.id, showAll);
  const list = showAll && all.data ? all.data : page.backlinks;
  const hidden = page.backlinkCount - list.length;
  const wikiOf = (showId: string | null) =>
    showId && showId !== page.showId ? allShows.find((s) => s.id === showId)?.name : undefined;
  return (
    <BacklinksSection backlinks={list} wikiOf={wikiOf}>
      {hidden > 0 && (
        <li className="flex items-baseline gap-1.5 text-sm text-si-dim">
          {all.isError && <span role="alert">Couldn’t load the other {hidden}.</span>}
          <Button
            variant="link"
            size="inline"
            disabled={all.isFetching}
            aria-busy={all.isFetching}
            onClick={() => (showAll ? void all.refetch() : setShowAll(true))}
            className="inline-flex items-center gap-1 text-sm text-si-dim decoration-(--si-line-strong)"
          >
            {all.isFetching && (
              <Spinner role="presentation" aria-hidden="true" className="size-3" />
            )}
            {all.isError ? 'Try again' : `and ${hidden} more`}
          </Button>
        </li>
      )}
    </BacklinksSection>
  );
}
