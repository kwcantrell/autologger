import { BookOpenIcon, ChevronDownIcon, ChevronRightIcon, FilmIcon } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { settingsOpen, TRANSPORT_LABEL, transportStatus, useStore } from '@/lib/store';
import { SearchPalette } from '@/routes/search/SearchPalette';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu';
import { SidebarTrigger } from '@/shared/components/ui/sidebar';
import { cn } from '@/shared/lib/utils';
import { ROLE_LABEL, useActive } from './useActive';

const CRUMB = 'min-w-0 shrink px-2 max-md:gap-0.5 max-md:px-1!';
const TEAM_CRUMB = 'max-md:min-w-[min(4.5rem,16vw)] max-md:shrink-[3]';
const CRUMB_NAME = 'min-w-0 max-w-[22ch] truncate text-[15px] max-md:text-sm';
const CRUMB_SEP = 'size-3.5 shrink-0 text-si-dim';

export function TopBar() {
  const active = useActive();
  const status = useStore(transportStatus);
  const [location, navigate] = useLocation();

  const leaveSessionIfOtherShow = (showId: string) => {
    // Switching show closes a session from another show (the rail lists the new show's sessions).
    if (location.startsWith('/sessions/') && status.sessionId && showId !== active.show?.id)
      navigate('/');
  };

  const label = TRANSPORT_LABEL[status.state];
  const sessionTitle = status.title?.trim() || 'Untitled session';
  const statusBadge = (
    <Badge variant="transport">
      <span data-slot="live-dot" aria-hidden="true" className="size-2 rounded-full bg-current" />
      {label}
    </Badge>
  );

  return (
    <header
      data-slot="topbar"
      className="flex h-(--topbar-h) w-full min-w-0 shrink-0 items-center gap-1.5 px-2.5 md:gap-3 md:px-4"
    >
      <SidebarTrigger className="size-(--h-ctl) shrink-0" title="Toggle sidebar ( [ )" />

      <nav
        aria-label="Current team and show"
        className="flex min-w-0 flex-1 items-center gap-1 max-md:gap-0"
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                className={cn(CRUMB, TEAM_CRUMB)}
                title={active.team?.name || 'Switch team'}
              />
            }
          >
            <span className="sr-only">Switch team: </span>
            <span className={cn(CRUMB_NAME, 'max-md:max-w-[10ch]')}>
              {active.team?.name || 'No team'}
            </span>
            <ChevronDownIcon data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[300px] max-w-[calc(100vw-1.5rem)]">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Your teams</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={active.team?.id ?? ''}
                onValueChange={(id: string) => {
                  if (id === active.team?.id) return;
                  active.setTeam(id);
                  if (location.startsWith('/sessions/')) navigate('/');
                }}
              >
                {active.teams.map((team) => {
                  const count = active.allShows.filter((s) => s.teamId === team.id).length;
                  return (
                    <DropdownMenuRadioItem key={team.id} value={team.id}>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{team.name}</span>
                        <span className="text-xs font-normal text-muted-foreground">{`${count} show${count === 1 ? '' : 's'}`}</span>
                      </span>
                      <Badge variant="outline">{ROLE_LABEL[team.role]}</Badge>
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <ChevronRightIcon aria-hidden="true" className={CRUMB_SEP} />

        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={active.shows.length === 0}
            render={
              <Button
                variant="ghost"
                className={cn(CRUMB, 'max-md:min-w-[min(4.5rem,13vw)]')}
                title={active.show?.name || 'Switch show'}
              />
            }
          >
            <span className="sr-only">Switch show: </span>
            <span className={cn(CRUMB_NAME, 'max-md:max-w-[18ch]')}>
              {active.show?.name || 'No show'}
            </span>
            <ChevronDownIcon data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[300px] max-w-[calc(100vw-1.5rem)]">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate">
                Shows in {active.team?.name}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={active.show?.id ?? ''}
                onValueChange={(id: string) => {
                  leaveSessionIfOtherShow(id);
                  active.setShow(id);
                }}
              >
                {active.shows.map((show) => (
                  <DropdownMenuRadioItem key={show.id} value={show.id}>
                    <span className="truncate">{show.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Phones drop this separator: the pill must fit beside the crumbs, not under Search. */}
        <ChevronRightIcon aria-hidden="true" className={cn(CRUMB_SEP, 'max-md:hidden')} />

        {status.sessionId ? (
          <Button
            variant="ghost"
            className="shrink-0 px-1.5 max-md:px-1 md:min-w-0 md:shrink"
            aria-label={`${label}, ${sessionTitle}. Return to session`}
            title={`Return to ${sessionTitle}`}
            onClick={() => {
              settingsOpen.set(null);
              const target = `/sessions/${encodeURIComponent(status.sessionId!)}`;
              if (location !== target) navigate(target);
            }}
          >
            {statusBadge}
            <span className="min-w-0 truncate font-tc text-xs font-medium text-muted-foreground max-md:hidden">
              {sessionTitle}
            </span>
          </Button>
        ) : (
          <div className="flex shrink-0 items-center gap-2 px-1.5 max-md:px-1 md:min-w-0 md:shrink">
            {statusBadge}
            <span className="min-w-0 truncate text-xs text-muted-foreground max-md:sr-only">
              No session open
            </span>
          </div>
        )}
      </nav>

      <SearchPalette />

      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 md:w-auto md:px-2.5"
        nativeButton={false}
        render={<Link href="/wiki" aria-label="Wiki" title="Wiki" />}
      >
        <BookOpenIcon aria-hidden="true" />
        <span className="max-md:hidden">Wiki</span>
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 max-md:hidden md:w-auto md:px-2.5"
        nativeButton={false}
        render={<Link href="/compilations" aria-label="Compilations" title="Video compilations" />}
      >
        <FilmIcon aria-hidden="true" />
        <span>Compilations</span>
      </Button>

      <span role="status" className="sr-only">{`Transport ${label}`}</span>
    </header>
  );
}
