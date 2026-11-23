import type { Session, WikiListItem } from '@autologger/contract';
import { BookOpenIcon, FileTextIcon, WifiOffIcon } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import type { LiveStatus } from '@/api/live';
import {
  listAllWikiPages,
  useCapabilities,
  useCategories,
  useEvents,
  useMedia,
  useWikiCiting,
} from '@/api/queries';
import { errorMessage, rpc } from '@/api/rpc';
import { useSessionWrite } from '@/api/session/writes';
import { isTypingTarget } from '@/lib/keys';
import { type TransportTint, transportStatus } from '@/lib/store';
import { fmtShort, useTransportClockStore } from '@/lib/timecode';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu';
import { Spinner } from '@/shared/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import { isOverlayOpen } from '@/shared/ui/overlayOpen';
import { AudioMenu, UploadBanner } from './AudioMenu';
import { usePlayer } from './audio/usePlayer';
import { useRecorder } from './audio/useRecorder';
import { WorkspaceContext, type Workspace as WorkspaceCtx, type WorkspaceTab } from './context';
import { SessionDetailsButton } from './SessionDetailsDialog';
import { TransportStrip } from './TransportStrip';
import { EventsTab } from './tabs/EventsTab';
import { ExportTab } from './tabs/ExportTab';
import { TopicsTab } from './tabs/TopicsTab';
import { TranscriptTab } from './tabs/TranscriptTab';

const DashboardsTab = lazy(() =>
  import('./tabs/DashboardsTab').then((m) => ({ default: m.DashboardsTab })),
);
const AgentsTab = lazy(() => import('./tabs/AgentsTab').then((m) => ({ default: m.AgentsTab })));

const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: 'events', label: 'Event Feed' },
  { id: 'transcript', label: 'Transcript' },
  { id: 'topics', label: 'Topics' },
  { id: 'dashboards', label: 'Dashboards' },
  { id: 'agents', label: 'Agents' },
  { id: 'export', label: 'Export' },
];

export function Workspace({ session, live }: { session: Session; live: LiveStatus }) {
  const sessionId = session.id;
  const write = useSessionWrite(sessionId);
  const caps = useCapabilities().data;
  const canWrite = session.access !== 'read';
  const categories = useCategories(session.showId);
  const events = useEvents(sessionId);
  const media = useMedia(sessionId, caps?.storage !== false);
  // A store: the clock ticks each frame while rolling, and only what draws it re-renders.
  const clock = useTransportClockStore(session);

  const [tab, setTab] = useState<WorkspaceTab>('events');
  const [visited, setVisited] = useState<Set<WorkspaceTab>>(() => new Set(['events']));
  const [flashEventId, setFlashEventId] = useState<{ id: string; n: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const player = usePlayer(media.data, true);
  const { seek: playerSeek, toggle: playerToggle } = player;
  const recorder = useRecorder(sessionId, () => clock.get().elapsedSec);
  const recording = recorder.state === 'recording' || recorder.state === 'starting';

  const tint: TransportTint = recording
    ? 'recording'
    : session.isRolling
      ? 'rolling'
      : player.isPlaying
        ? 'playback'
        : 'stopped';

  // Publish the shell tint + top-bar pill.
  useEffect(() => {
    transportStatus.set({ state: tint, sessionId, title: session.title });
  }, [tint, sessionId, session.title]);
  useEffect(
    () => () => transportStatus.set({ state: 'stopped', sessionId: null, title: null }),
    [],
  );

  const switchTab = useCallback((t: WorkspaceTab) => {
    setTab(t);
    setVisited((v) => (v.has(t) ? v : new Set(v).add(t)));
  }, []);

  const seek = useCallback(
    (sec: number, play = true) => {
      if (session.isRolling) {
        showToast('Stop timecode to play back audio.', true);
        return;
      }
      void playerSeek(sec, play);
    },
    [playerSeek, session.isRolling],
  );

  const revealEvent = useCallback(
    (eventId: string) => {
      switchTab('events');
      setFlashEventId((f) => ({ id: eventId, n: (f?.n ?? 0) + 1 }));
    },
    [switchTab],
  );

  // ── transport ─────────────────────────────────────────────
  const transport = useCallback(
    async (action: 'start' | 'stop' | 'reset') => {
      setBusy(true);
      try {
        if (action === 'stop' && recording) await recorder.stop();
        if (action === 'start' && player.isPlaying) void player.toggle();
        // The result shows at once; the socket's transport push carries the same state.
        await write(`transport.${action}`, { sessionId });
      } catch (e) {
        showToast(errorMessage(e), true);
      } finally {
        setBusy(false);
      }
    },
    [sessionId, recording, recorder, player, write],
  );

  // Recording ends when the transport stops (here or in another tab / Companion).
  useEffect(() => {
    if (!session.isRolling && recorder.state === 'recording') void recorder.stop();
  }, [session.isRolling, recorder]);

  // Space: play / pause (not while typing, with an overlay, or on a focused button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)
        return;
      if (isTypingTarget(e.target) || isOverlayOpen()) return;
      if (e.target instanceof HTMLElement && e.target.closest('button,a,[role=slider],[role=tab]'))
        return;
      if (session.isRolling) return;
      e.preventDefault();
      void playerToggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playerToggle, session.isRolling]);

  // Deep links from search and wiki citations: ?t=<sec>[&to=<sec>]&event=<id>&topic=<id>.
  // With `to`, pressing play plays the cited range and pauses at its end.
  const [, navigate] = useLocation();
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (deepLinkDone.current) return;
    const p = new URLSearchParams(location.search);
    const t = p.get('t');
    const ev = p.get('event');
    const topic = p.get('topic');
    const tr = p.get('tab');
    if (!t && !ev && !topic && !tr) {
      deepLinkDone.current = true;
      return;
    }
    // Wait for what the link needs, but not on a failed query: an error still opens the tab and
    // strips the query string (the feed shows the error).
    if (ev && events.isPending) return;
    if (t && media.isPending && caps?.storage) return;
    deepLinkDone.current = true;
    if (tr && TABS.some((x) => x.id === tr)) switchTab(tr as WorkspaceTab);
    if (ev) revealEvent(ev);
    else if (topic) switchTab('topics');
    const to = Number(p.get('to') ?? Number.NaN);
    if (t && Number.isFinite(Number(t)) && !session.isRolling)
      void player.seek(Number(t), false, Number.isFinite(to) ? to : null);
    navigate(location.pathname, { replace: true });
  }, [
    events.isPending,
    media.isPending,
    caps?.storage,
    revealEvent,
    switchTab,
    player,
    session.isRolling,
    navigate,
  ]);

  const ctx: WorkspaceCtx = useMemo(
    () => ({ session, caps, canWrite, clock, player, seek, setTab: switchTab, revealEvent }),
    [session, caps, canWrite, clock, player, seek, switchTab, revealEvent],
  );

  const eventsList = events.data ?? [];

  return (
    <WorkspaceContext.Provider value={ctx}>
      <div
        id="v3-session-active"
        className="relative flex min-h-[calc(100dvh-var(--topbar-h)-2.2rem)] flex-1 flex-col [overflow-x:clip] max-md:block max-md:min-h-0"
      >
        <section
          id="v4-log-session"
          aria-label="Log session"
          className="flex w-full min-w-0 flex-1 flex-col gap-5 pt-3 pb-6 [overflow-x:clip] max-md:block"
        >
          {live.state === 'reconnecting' && (
            <Alert className="mx-4 w-auto max-md:mx-3" role="status">
              <WifiOffIcon />
              <AlertDescription>
                Live updates paused — reconnecting to the server (attempt {live.attempt}). Changes
                from other people and agents will appear once it's back.
              </AlertDescription>
            </Alert>
          )}
          <UploadBanner sessionId={sessionId} />
          <TransportStrip
            tint={tint}
            busy={busy}
            categories={categories.data ?? []}
            categoriesError={categories.isError ? errorMessage(categories.error) : null}
            events={eventsList}
            recorder={recorder}
            onTransport={transport}
          />

          <Tabs
            value={tab}
            onValueChange={(v) => switchTab(v as WorkspaceTab)}
            className="min-h-0 flex-[1_1_0] gap-0"
          >
            <div className="relative z-0 mx-4 mb-3 flex shrink-0 items-end gap-2 pt-[0.3rem] max-md:mx-3 max-lg:overflow-x-auto max-lg:overflow-y-hidden max-lg:[scrollbar-width:none]">
              <TabsList variant="line" aria-label="Feed tabs" className="max-lg:flex-none">
                {TABS.map((t) => (
                  <TabsTrigger key={t.id} value={t.id}>
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <AudioMenu
                  session={session}
                  caps={caps}
                  canWrite={canWrite}
                  segments={media.data}
                  mediaError={media.error}
                />
                <SessionDetailsButton session={session} />
                <SessionWikiButton session={session} />
              </div>
            </div>
            {TABS.map((t) => (
              <TabsContent
                key={t.id}
                value={t.id}
                keepMounted
                hidden={tab !== t.id}
                className="relative z-[1] flex min-h-0 flex-1 flex-col"
              >
                {visited.has(t.id) && (
                  <Suspense
                    fallback={
                      <div className="flex justify-center py-8">
                        <Spinner />
                      </div>
                    }
                  >
                    {t.id === 'events' && <EventsTab session={session} flash={flashEventId} />}
                    {t.id === 'transcript' && <TranscriptTab session={session} />}
                    {t.id === 'topics' && <TopicsTab session={session} />}
                    {t.id === 'dashboards' && <DashboardsTab session={session} />}
                    {t.id === 'agents' && <AgentsTab session={session} />}
                    {t.id === 'export' && <ExportTab session={session} />}
                  </Suspense>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </section>
      </div>
    </WorkspaceContext.Provider>
  );
}

/** Cited ranges of one page as short clock times, e.g. "12:04–12:31, 1:02:10". */
function rangesLabel(cites: NonNullable<WikiListItem['citations']>, max = 3): string {
  const shown = cites
    .slice(0, max)
    .map((c) =>
      c.endSec != null ? `${fmtShort(c.startSec)}–${fmtShort(c.endSec)}` : fmtShort(c.startSec),
    );
  return cites.length > max ? `${shown.join(', ')} +${cites.length - max} more` : shown.join(', ');
}

/** Wiki menu: open (or create) the session's recap page, and the pages citing this session. */
function SessionWikiButton({ session }: { session: Session }) {
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const citing = useWikiCiting(session.showId, session.id);
  const count = citing.data?.length ?? 0;
  const open = async () => {
    setBusy(true);
    try {
      const pages = await listAllWikiPages(session.showId, 'session');
      const existing = pages.find((p) => p.sessionId === session.id);
      if (existing) {
        navigate(`/wiki/${encodeURIComponent(existing.id)}`);
        return;
      }
      if (session.access === 'read') {
        showToast(
          "This session has no wiki page yet, and you can't create one with read-only access.",
          true,
        );
        return;
      }
      const page = await rpc('wiki.upsert', {
        showId: session.showId,
        kind: 'session',
        title: session.title || `Session ${session.id}`,
        bodyMd: '',
        sessionId: session.id,
      });
      navigate(`/wiki/${encodeURIComponent(page.id)}`);
    } catch (e) {
      showToast(`Could not open the wiki page. ${errorMessage(e)}`, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <DropdownMenu onOpenChange={(o) => o && void citing.refetch()}>
      <DropdownMenuTrigger
        disabled={busy}
        render={<Button variant="ghost" size="sm" className="text-si-muted hover:text-si-fg" />}
      >
        {busy ? <Spinner /> : <BookOpenIcon aria-hidden="true" />}
        <span className="max-xl:sr-only">Wiki</span>
        {count > 0 && (
          <Badge
            variant="outline"
            aria-label={`, cited in ${count} wiki ${count === 1 ? 'page' : 'pages'}`}
          >
            {count}
          </Badge>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[320px] max-w-[calc(100vw-2rem)]">
        <DropdownMenuItem onClick={() => void open()}>
          <BookOpenIcon aria-hidden="true" />
          <span>Session recap page</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Cited in{count > 0 ? ` (${count})` : ''}</DropdownMenuLabel>
          {citing.isPending ? (
            <div className="flex justify-center py-2">
              <Spinner />
            </div>
          ) : citing.isError ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Could not load citing pages. {errorMessage(citing.error)}
            </p>
          ) : count === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No wiki page cites this session yet.
            </p>
          ) : (
            <div className="max-h-[50svh] overflow-y-auto">
              {citing.data.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => navigate(`/wiki/${encodeURIComponent(p.id)}`)}
                >
                  <FileTextIcon aria-hidden="true" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{p.title}</span>
                    <span
                      className="truncate text-xs text-muted-foreground tabular-nums"
                      title={rangesLabel(p.citations ?? [], Infinity)}
                    >
                      {p.kind} · {rangesLabel(p.citations ?? [])}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
