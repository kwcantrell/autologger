import { lazy, Suspense, useEffect } from 'react';
import { Route, Switch, useLocation, useRoute } from 'wouter';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { RouteLoadingState, RouteState } from '@/components/RouteState';
import { isTypingTarget } from '@/lib/keys';
import {
  newSessionOpen,
  settingsOpen,
  shortcutsOpen,
  transportStatus,
  useStore,
} from '@/lib/store';
import { HomeRoute } from '@/routes/HomeRoute';
import { ShortcutsDialog } from '@/session/ShortcutsDialog';
import { Button } from '@/shared/components/ui/button';
import { SidebarProvider, useSidebar } from '@/shared/components/ui/sidebar';
import { isOverlayOpen } from '@/shared/ui/overlayOpen';
import { Rail } from './Rail';
import { TopBar } from './TopBar';

const SessionRoute = lazy(() =>
  import('@/session/SessionRoute').then((m) => ({ default: m.SessionRoute })),
);
const SearchRoute = lazy(() =>
  import('@/routes/search/SearchRoute').then((m) => ({ default: m.SearchRoute })),
);
const WikiRoute = lazy(() =>
  import('@/routes/wiki/WikiRoute').then((m) => ({ default: m.WikiRoute })),
);
const TeamWikiRoute = lazy(() =>
  import('@/routes/wiki/WikiRoute').then((m) => ({ default: m.TeamWikiRoute })),
);
const WikiPageView = lazy(() =>
  import('@/routes/wiki/WikiPageView').then((m) => ({ default: m.WikiPageView })),
);
const CompilationsRoute = lazy(() =>
  import('@/routes/compilations/CompilationsRoute').then((m) => ({
    default: m.CompilationsRoute,
  })),
);
const ChangesRoute = lazy(() =>
  import('@/routes/changes/ChangesRoute').then((m) => ({ default: m.ChangesRoute })),
);
const SettingsView = lazy(() =>
  import('@/settings/SettingsView').then((m) => ({ default: m.SettingsView })),
);
const NewSessionModal = lazy(() =>
  import('@/routes/NewSessionModal').then((m) => ({ default: m.NewSessionModal })),
);

/** `[` toggles the rail (not while typing or with an overlay other than Settings open). */
function SidebarShortcut() {
  const { toggleSidebar } = useSidebar();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || isOverlayOpen(document, '[data-slot="settings-view"]'))
        return;
      e.preventDefault();
      toggleSidebar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);
  return null;
}

/** `?` opens the shortcuts reference anywhere in the shell. */
function ShortcutsKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || isOverlayOpen()) return;
      e.preventDefault();
      shortcutsOpen.set(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}

function NotFound() {
  const [, navigate] = useLocation();
  return (
    <RouteState
      frame="route"
      role="status"
      title="Not found"
      actions={
        <Button variant="outline" className="h-11 w-full" onClick={() => navigate('/')}>
          Back to sessions
        </Button>
      }
    >
      There's no page at this link. It may have been removed, or the link may be wrong.
    </RouteState>
  );
}

function TeamsRoute() {
  const [, navigate] = useLocation();
  useEffect(() => {
    settingsOpen.set('members');
    // Closing Settings opened from /teams goes home.
    return settingsOpen.subscribe(() => {
      if (!settingsOpen.get()) navigate('/');
    }) as () => void;
  }, [navigate]);
  return <HomeRoute />;
}

export function AppShell() {
  const transport = useStore(transportStatus);
  const showNew = useStore(newSessionOpen);
  const settings = useStore(settingsOpen);
  const [onSession, params] = useRoute<{ id: string }>('/sessions/:id');
  const activeSessionId = onSession ? decodeURIComponent(params.id) : null;

  return (
    <SidebarProvider
      className="m-0 h-[100dvh] min-h-0 w-full max-w-none flex-1 flex-col p-0 max-md:block max-md:h-auto"
      data-transport={transport.state}
    >
      <SidebarShortcut />
      <ShortcutsKey />
      <TopBar />
      <div
        id="v6-app"
        className="flex min-h-0 w-full min-w-0 flex-1 flex-row items-stretch overflow-hidden max-md:block max-md:overflow-visible"
      >
        <Rail activeSessionId={activeSessionId} />
        {/* The gutter is reserved (md+), so content width doesn't change when a page starts or stops
            scrolling: on the session page Start/Stop changes the strip's height, and the 8px
            shift re-laid out a long transcript's whole table (#330). */}
        <main
          id="v3-main"
          className="relative m-0 block min-h-0 w-full min-w-0 max-w-none flex-1 [overflow-x:clip] overflow-y-visible md:overflow-y-auto md:[scrollbar-gutter:stable]"
        >
          {showNew && (
            <ErrorBoundary>
              <Suspense fallback={null}>
                <NewSessionModal initialMode={showNew} onClose={() => newSessionOpen.set(false)} />
              </Suspense>
            </ErrorBoundary>
          )}
          {settings && (
            <ErrorBoundary>
              <Suspense fallback={null}>
                <SettingsView section={settings} />
              </Suspense>
            </ErrorBoundary>
          )}
          <ErrorBoundary>
            <Suspense fallback={<RouteLoadingState label="Loading" />}>
              <Switch>
                <Route path="/">
                  <HomeRoute />
                </Route>
                <Route path="/teams" component={TeamsRoute} />
                <Route path="/teams/:teamId/wiki">
                  {(p) => <TeamWikiRoute key={p.teamId} teamId={decodeURIComponent(p.teamId)} />}
                </Route>
                <Route path="/sessions/:id">
                  {(p) => <SessionRoute key={p.id} sessionId={decodeURIComponent(p.id)} />}
                </Route>
                <Route path="/search" component={SearchRoute} />
                <Route path="/wiki" component={WikiRoute} />
                <Route path="/compilations" component={CompilationsRoute} />
                <Route path="/changes" component={ChangesRoute} />
                <Route path="/wiki/:pageId">
                  {(p) => <WikiPageView pageId={decodeURIComponent(p.pageId)} />}
                </Route>
                <Route component={NotFound} />
              </Switch>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <ShortcutsDialog />
    </SidebarProvider>
  );
}
