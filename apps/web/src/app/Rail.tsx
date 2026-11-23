import type { Job, Session } from '@autologger/contract';
import {
  AudioLines,
  Film,
  History,
  MoreVertical,
  Plus,
  Search,
  Settings,
  Upload,
  X,
} from 'lucide-react';
import { lazy, type ReactElement, Suspense, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocation } from 'wouter';
import { useLiveShow } from '@/api/liveShow';
import { qk, useOpMutation, useSessions, useShowJobs } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { jobsBySession, jobsSummary } from '@/api/showJobs';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { LoadingVideo } from '@/components/RouteState';
import { newSessionOpen, settingsOpen } from '@/lib/store';
import { fmtSec, formatFrames, isMediaOnly, useTransportClock } from '@/lib/timecode';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/shared/components/ui/input-group';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from '@/shared/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip';
import { cn } from '@/shared/lib/utils';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { Tooltip as SimpleTooltip } from '@/shared/ui/Tooltip';
import { fmtDateOnly } from '@/shared/utils/fmtDateOnly';
import { JobMark, JobsIcon, ShowJobsDialog } from './ShowJobs';
import { useActive } from './useActive';

// Opened from a card's menu; loaded on demand to keep it (and the key-terms form) out of the main chunk.
const SessionDetailsDialog = lazy(() =>
  import('@/session/SessionDetailsDialog').then((m) => ({ default: m.SessionDetailsDialog })),
);

export const APP_VERSION = '3.0.0';
const ICON_ONLY_LABEL = 'group-data-[collapsible=icon]:sr-only';

function StripTooltip({ label, children }: { label: string; children: ReactElement }) {
  const { state, isMobile } = useSidebar();
  const [open, setOpen] = useState(false);
  const enabled = state === 'collapsed' && !isMobile;
  return (
    <Tooltip open={enabled && open} onOpenChange={setOpen}>
      <TooltipTrigger render={children} />
      <TooltipContent side="right" align="center" hidden={!enabled}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function Rail({ activeSessionId }: { activeSessionId: string | null }) {
  const active = useActive();
  const sessions = useSessions(active.show?.id);
  // Pushes job and session-list changes of the whole show; polling is the fallback.
  const showLive = useLiveShow(active.show?.id);
  const showJobs = useShowJobs(active.show?.id, showLive.state === 'open');
  // The show the jobs dialog was opened for: it closes when the active show changes.
  const [jobsOpenFor, setJobsOpenFor] = useState<string | null>(null);
  const { state, isMobile, setOpen, setOpenMobile } = useSidebar();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [, navigate] = useLocation();

  const closeSheet = () => {
    if (isMobile) setOpenMobile(false);
  };
  const expandAndFocusSearch = () => {
    if (!isMobile && state === 'collapsed') flushSync(() => setOpen(true));
    searchRef.current?.focus({ preventScroll: true });
  };

  const all = sessions.data ?? [];
  const recent = all.filter((s) => !s.archivedAt);
  const archived = all.filter((s) => s.archivedAt);
  const q = query.trim().toLowerCase();
  const match = (s: Session) =>
    !q || s.title.toLowerCase().includes(q) || s.episode.toLowerCase().includes(q);
  const jobBySession = jobsBySession(showJobs.data);
  const jobsLabel = jobsSummary(showJobs.data);
  const openSession = (id: string) => {
    closeSheet();
    settingsOpen.set(null);
    navigate(`/sessions/${encodeURIComponent(id)}`);
  };

  return (
    <Sidebar
      collapsible="icon"
      id="v6-rail"
      aria-label="Navigation"
      className="top-(--topbar-h) h-[calc(100svh-var(--topbar-h))]"
    >
      <SidebarHeader className="gap-3 px-3 pt-3 group-data-[collapsible=icon]:px-2">
        {active.canWriteShow && (
          <div className="grid grid-cols-2 gap-1.5 group-data-[collapsible=icon]:grid-cols-1">
            <StripTooltip label="New session">
              <Button
                id="v6-btn-new-session"
                className="w-full min-w-0"
                onClick={() => {
                  closeSheet();
                  newSessionOpen.set('session');
                }}
              >
                <Plus aria-hidden="true" data-icon="inline-start" />
                <span className={ICON_ONLY_LABEL}>New session</span>
              </Button>
            </StripTooltip>
            <StripTooltip label="Import">
              <Button
                variant="outline"
                className="w-full min-w-0"
                title="New session from an audio file or a YouTube link, or one session per video of a YouTube playlist"
                onClick={() => {
                  closeSheet();
                  newSessionOpen.set('import');
                }}
              >
                <Upload aria-hidden="true" data-icon="inline-start" />
                <span className={ICON_ONLY_LABEL}>Import</span>
              </Button>
            </StripTooltip>
          </div>
        )}

        {jobsLabel && (
          <StripTooltip label={`Background jobs: ${jobsLabel}`}>
            <Button
              variant="ghost"
              size="sm"
              className="w-full min-w-0 justify-start text-si-muted hover:text-si-fg group-data-[collapsible=icon]:justify-center"
              aria-label={`Background jobs: ${jobsLabel}`}
              onClick={() => setJobsOpenFor(active.show?.id ?? null)}
            >
              <JobsIcon data={showJobs.data} />
              <span className={cn('truncate', ICON_ONLY_LABEL)}>{jobsLabel}</span>
            </Button>
          </StripTooltip>
        )}
        {active.show && jobsOpenFor === active.show.id && (
          <ShowJobsDialog
            showName={active.show.name}
            data={showJobs.data}
            error={showJobs.error}
            sessions={all}
            canWriteShow={active.canWriteShow}
            onOpenSession={(id) => {
              setJobsOpenFor(null);
              openSession(id);
            }}
            onOpenCompilations={() => {
              setJobsOpenFor(null);
              closeSheet();
              navigate('/compilations');
            }}
            onOpenSettings={() => {
              setJobsOpenFor(null);
              closeSheet();
            }}
            onClose={() => setJobsOpenFor(null)}
          />
        )}

        <div className="[display:none] group-data-[collapsible=icon]:block">
          <StripTooltip label="Search sessions">
            <Button
              variant="outline"
              className="w-full"
              aria-label="Search sessions"
              onClick={expandAndFocusSearch}
            >
              <Search aria-hidden="true" />
            </Button>
          </StripTooltip>
        </div>

        {/* The icon sits 10px in and the text 33px, as in the rail's narrower field before. */}
        <InputGroup className="bg-background group-data-[collapsible=icon]:hidden has-[>[data-align=inline-start]]:[&>input]:pl-[0.4375rem]">
          <InputGroupInput
            ref={searchRef}
            type="search"
            className="[&::-webkit-search-cancel-button]:appearance-none"
            placeholder="Search sessions…"
            aria-label="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
          <InputGroupAddon className="pl-[0.5625rem]">
            <Search aria-hidden="true" />
          </InputGroupAddon>
          {query !== '' && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus({ preventScroll: true });
                }}
              >
                <X aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </SidebarHeader>

      <SidebarContent className="gap-0 group-data-[collapsible=icon]:invisible">
        <SidebarGroup>
          <SidebarGroupLabel>Recent sessions</SidebarGroupLabel>
          <SidebarGroupContent>
            {!active.show ? (
              <p className={EMPTY_NOTE}>
                {active.showsLoading
                  ? 'Loading shows…'
                  : active.canManageTeam
                    ? 'This team has no shows yet. Add one in Settings → Shows.'
                    : "You can't open any show in this team yet. Ask a team admin for access."}
              </p>
            ) : sessions.isPending ? (
              <div className="flex justify-center py-2">
                <LoadingVideo />
              </div>
            ) : sessions.isError ? (
              <p className={EMPTY_NOTE}>Couldn't load sessions. {errorMessage(sessions.error)}</p>
            ) : recent.length === 0 ? (
              <p className={EMPTY_NOTE}>No sessions yet. Create one to start logging.</p>
            ) : recent.filter(match).length === 0 ? (
              <p className={EMPTY_NOTE}>No sessions match “{query}”.</p>
            ) : (
              <SidebarMenu>
                {recent.filter(match).map((s) => (
                  <SessionCard
                    key={s.id}
                    session={s}
                    isActive={s.id === activeSessionId}
                    job={jobBySession.get(s.id)}
                    onSelect={() => openSession(s.id)}
                    onClose={() => {
                      closeSheet();
                      navigate('/');
                    }}
                  />
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

        {archived.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Archived</SidebarGroupLabel>
            <SidebarGroupContent>
              {archived.filter(match).length === 0 ? (
                <p className={EMPTY_NOTE}>No archived sessions match “{query}”.</p>
              ) : (
                <SidebarMenu>
                  {archived.filter(match).map((s) => (
                    <ArchivedCard key={s.id} session={s} />
                  ))}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarSeparator className="mx-0" />
      <SidebarFooter className="px-3 group-data-[collapsible=icon]:px-2">
        <SidebarMenu className="group-data-[collapsible=icon]:items-center">
          {/* On phones the top bar has no room for its Compilations link; the rail carries it. */}
          <SidebarMenuItem className="md:hidden">
            <SidebarMenuButton
              tooltip="Compilations"
              onClick={() => {
                closeSheet();
                navigate('/compilations');
              }}
            >
              <Film aria-hidden="true" />
              <span>Compilations</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {active.show && (
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Changes"
                title="Every change to this show, with undo"
                onClick={() => {
                  closeSheet();
                  settingsOpen.set(null);
                  navigate('/changes');
                }}
              >
                <History aria-hidden="true" />
                <span>Changes</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton
              id="v6-btn-settings"
              tooltip="Settings"
              onClick={() => {
                closeSheet();
                settingsOpen.set((cur) => cur ?? lastSettingsSection());
              }}
            >
              <Settings aria-hidden="true" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <p
          className="m-0 truncate text-center font-tc text-[0.625rem] text-muted-foreground select-none"
          title={`AutoLogger ${APP_VERSION}`}
        >
          v{APP_VERSION}
        </p>
      </SidebarFooter>
    </Sidebar>
  );
}

let lastSection: Parameters<typeof settingsOpen.set>[0] = 'show-details';
settingsOpen.subscribe(() => {
  const v = settingsOpen.get();
  if (v) lastSection = v;
});
const lastSettingsSection = () => (typeof lastSection === 'string' ? lastSection : 'show-details');

const EMPTY_NOTE = 'm-0 px-2 py-1.5 text-[13px] leading-snug text-muted-foreground';
const CARD_TITLE = 'truncate font-semibold';
const META_ROW = 'flex min-w-0 flex-row items-baseline justify-between gap-1';
const CARD_META = 'min-w-0 truncate text-xs font-normal text-muted-foreground';
const RUNTIME = 'shrink-0 font-tc text-xs text-muted-foreground tabular-nums';

function MetaRow({ session: s }: { session: Session }) {
  const clock = useTransportClock(s.isRolling ? s : null);
  const live = s.isRolling;
  const runtime = formatFrames(s.elapsedFrames, s.frameRate).replace(/[:;]\d{2}$/, '');
  const mediaOnly = isMediaOnly(s);
  return (
    <div className={META_ROW}>
      <span
        className={CARD_META}
      >{`${fmtDateOnly(s.episodeDate ?? s.createdAt)} · ${s.eventCount} ${s.eventCount === 1 ? 'event' : 'events'}`}</span>
      <SimpleTooltip
        content={live ? 'Current timecode' : mediaOnly ? 'Audio length' : 'Total runtime'}
      >
        <span
          className={cn(
            RUNTIME,
            live && 'text-foreground!',
            mediaOnly && 'inline-flex items-center gap-1',
          )}
        >
          {mediaOnly && <AudioLines className="size-3" role="img" aria-label="Audio length" />}
          {live
            ? clock.timecode.replace(/[:;]\d{2}$/, '')
            : mediaOnly
              ? fmtSec(s.audioSeconds)
              : runtime}
        </span>
      </SimpleTooltip>
    </div>
  );
}

function useSessionActions(s: Session) {
  const [, navigate] = useLocation();
  const { confirm, confirmElement } = useConfirm();
  const invalidate = () => [qk.sessionsAll, qk.session(s.id)];
  const archive = useOpMutation('sessions.archive', { invalidate });
  const del = useOpMutation('sessions.delete', {
    invalidate: () => [qk.sessionsAll, qk.showJobsAll],
  });

  return {
    confirmElement,
    async archive(archived: boolean) {
      const ok = await confirm(
        archived
          ? {
              title: 'Archive session',
              message: `Archive “${s.title}”? You can restore it later from Archived sessions.`,
              confirmLabel: 'Archive',
            }
          : {
              title: 'Restore session',
              message: `Restore “${s.title}” to Recent sessions?`,
              confirmLabel: 'Restore',
            },
      );
      if (!ok) return;
      archive.mutate(
        { sessionId: s.id, archived },
        {
          onSuccess: () => {
            showToast(archived ? 'Session archived.' : 'Session restored.');
            if (archived && location.pathname.includes(s.id)) navigate('/');
          },
          onError: (e) => showToast(errorMessage(e), true),
        },
      );
    },
    async remove() {
      const ok = await confirm({
        title: 'Delete session',
        message: `Permanently delete “${s.title}”? Its events, transcript, topics, dashboards and audio go with it. This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      del.mutate(
        { sessionId: s.id },
        {
          onSuccess: () => {
            showToast('Session permanently deleted.');
            if (location.pathname.includes(s.id)) navigate('/');
          },
          onError: (e) => showToast(errorMessage(e), true),
        },
      );
    },
  };
}

function CardMenu({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  children: React.ReactNode;
}) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger render={<SidebarMenuAction showOnHover aria-label="Session options" />}>
        <MoreVertical aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={6}
        onClick={stop}
        onKeyDown={stop}
      >
        <DropdownMenuGroup>{children}</DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SessionCard({
  session: s,
  isActive,
  job,
  onSelect,
  onClose,
}: {
  session: Session;
  isActive: boolean;
  /** The session's unfinished or recently failed background job, if any. */
  job: Job | undefined;
  onSelect: () => void;
  onClose: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const actions = useSessionActions(s);
  const canWrite = s.access !== 'read';
  return (
    <SidebarMenuItem
      data-session-id={s.id}
      data-live={s.isRolling || undefined}
      data-menu-open={menuOpen || undefined}
    >
      <SidebarMenuButton
        size="lg"
        isActive={isActive}
        aria-current={isActive ? 'page' : undefined}
        tooltip={s.title}
        className="h-auto min-h-12 flex-col items-stretch justify-center gap-0.5 py-1.5"
        onClick={() => {
          if (!isActive) onSelect();
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={CARD_TITLE} title={s.title || undefined}>
            {s.title || 'Untitled session'}
          </span>
          {s.isRolling && <Badge className="px-1 py-px text-[0.625rem] leading-none">LIVE</Badge>}
          {job && <JobMark job={job} />}
        </span>
        <MetaRow session={s} />
      </SidebarMenuButton>
      <CardMenu open={menuOpen} onOpenChange={setMenuOpen}>
        {isActive && <DropdownMenuItem onClick={onClose}>Close session</DropdownMenuItem>}
        <DropdownMenuItem onClick={() => setDetailsOpen(true)}>Details…</DropdownMenuItem>
        {canWrite && (
          <DropdownMenuItem onClick={() => void actions.archive(true)}>Archive</DropdownMenuItem>
        )}
        {canWrite && (
          <DropdownMenuItem variant="destructive" onClick={() => void actions.remove()}>
            Delete
          </DropdownMenuItem>
        )}
        {!canWrite && !isActive && (
          <DropdownMenuItem disabled>Read-only: you can view this show</DropdownMenuItem>
        )}
      </CardMenu>
      {detailsOpen && (
        <ErrorBoundary>
          <Suspense fallback={null}>
            <SessionDetailsDialog session={s} onClose={() => setDetailsOpen(false)} />
          </Suspense>
        </ErrorBoundary>
      )}
      {actions.confirmElement}
    </SidebarMenuItem>
  );
}

function ArchivedCard({ session: s }: { session: Session }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const actions = useSessionActions(s);
  return (
    <SidebarMenuItem data-session-id={s.id} data-menu-open={menuOpen || undefined}>
      <div className="flex w-full min-w-0 flex-col justify-center gap-0.5 rounded-ctl p-2 pr-8 text-sm">
        <span className={CARD_TITLE} title={s.title || undefined}>
          {s.title || 'Untitled session'}
        </span>
        <MetaRow session={s} />
      </div>
      {s.access !== 'read' && (
        <CardMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuItem onClick={() => void actions.archive(false)}>Restore</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => void actions.remove()}>
            Delete
          </DropdownMenuItem>
        </CardMenu>
      )}
      {actions.confirmElement}
    </SidebarMenuItem>
  );
}
