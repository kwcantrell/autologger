import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { useLiveSession } from '@/api/live';
import { qk, useOpMutation, useSession, useShows } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { selectShow } from '@/app/useActive';
import { RouteLoadingState, RouteState } from '@/components/RouteState';
import { showToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui/button';
import { Workspace } from './Workspace';

function BackToSessions() {
  const [, navigate] = useLocation();
  return (
    <Button variant="outline" className="h-11 w-full" onClick={() => navigate('/')}>
      Back to sessions
    </Button>
  );
}

export function SessionRoute({ sessionId }: { sessionId: string }) {
  const q = useSession(sessionId);
  const live = useLiveSession(q.data && !q.data.archivedAt ? sessionId : undefined);
  const restore = useOpMutation('sessions.archive', {
    invalidate: () => [qk.sessionsAll, qk.session(sessionId)],
  });
  const s = q.data;
  const shows = useShows().data;

  // Opening a session makes its show the active one (rail + top bar follow).
  const show = shows?.find((x) => x.id === s?.showId);
  useEffect(() => {
    if (show) selectShow(show);
  }, [show]);

  if (live.state === 'closed' && live.reason !== 'unauthenticated') {
    return (
      <RouteState
        frame="route"
        role="status"
        title={live.reason === 'deleted' ? 'Session deleted' : 'Access removed'}
        actions={<BackToSessions />}
      >
        {live.reason === 'deleted'
          ? 'Someone deleted this session while you had it open.'
          : 'Your access to this show was removed while the session was open. Ask a team owner or admin if that is a mistake.'}
      </RouteState>
    );
  }
  if (q.isPending) return <RouteLoadingState label="Loading session" />;
  if (q.isError) {
    if (q.error.code === 'not_found' || q.error.code === 'forbidden') {
      return (
        <RouteState
          frame="route"
          role="status"
          title="Session not found"
          actions={<BackToSessions />}
        >
          There's no session at this link that you can open. It may have been removed, the link may
          be wrong, or it belongs to a show you haven't been given access to.
        </RouteState>
      );
    }
    return (
      <RouteState
        frame="route"
        role="alert"
        title="Couldn't load session"
        actions={
          <>
            <Button
              className="h-11 w-full"
              disabled={q.isFetching}
              onClick={() => void q.refetch()}
            >
              {q.isFetching ? 'Retrying…' : 'Try again'}
            </Button>
            <BackToSessions />
          </>
        }
      >
        Something went wrong loading this session ({errorMessage(q.error)}). Check your connection
        and try again.
      </RouteState>
    );
  }
  if (!s) return null;
  if (s.archivedAt) {
    return (
      <RouteState
        frame="route"
        role="status"
        badge="Archived session"
        title={s.title || 'Untitled session'}
        actions={
          <>
            {s.access !== 'read' && (
              <Button
                className="h-11 w-full"
                disabled={restore.isPending}
                onClick={() =>
                  restore.mutate(
                    { sessionId, archived: false },
                    {
                      onError: (e) =>
                        showToast(`Couldn't restore the session. ${errorMessage(e)}`, true),
                    },
                  )
                }
              >
                {restore.isPending ? 'Restoring…' : 'Restore session'}
              </Button>
            )}
            <BackToSessions />
          </>
        }
      >
        This session is archived.{' '}
        {s.access !== 'read'
          ? 'Restore it to open the workspace.'
          : 'Ask someone with write access to the show to restore it.'}
      </RouteState>
    );
  }
  return <Workspace session={s} live={live} />;
}
