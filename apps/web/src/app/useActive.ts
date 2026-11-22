// Active team and show: client-side selection (persisted per browser) resolved against what the
// user can actually see. Falls back to the first team / first show when the stored one is gone.

import type { Show, Team, TeamRole } from '@autologger/contract';
import { useMemo } from 'react';
import { useMe, useShows } from '@/api/queries';
import { activeScope, useStore } from '@/lib/store';

export const ROLE_LABEL: Record<TeamRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
export const isManager = (role: TeamRole | undefined | null) => role === 'owner' || role === 'admin';

export interface Active {
  teams: Team[];
  team: Team | null;
  /** All shows the user can open, across teams. */
  allShows: Show[];
  /** Shows of the active team. */
  shows: Show[];
  show: Show | null;
  showsLoading: boolean;
  setTeam: (teamId: string) => void;
  setShow: (showId: string) => void;
  /** Owner/admin of the active team. */
  canManageTeam: boolean;
  /** Can log/create sessions in the active show. */
  canWriteShow: boolean;
}

export function selectTeam(teamId: string) {
  activeScope.set((s) => (s.teamId === teamId ? s : { teamId, showId: null }));
}
export function selectShow(show: Pick<Show, 'id' | 'teamId'>) {
  activeScope.set((s) => (s.teamId === show.teamId && s.showId === show.id ? s : { teamId: show.teamId, showId: show.id }));
}

export function useActive(): Active {
  const me = useMe().data;
  const showsQ = useShows();
  const scope = useStore(activeScope);
  const teams = me?.teams ?? [];
  const allShows = showsQ.data ?? [];

  return useMemo(() => {
    const team = teams.find((t) => t.id === scope.teamId) ?? teams[0] ?? null;
    const shows = team ? allShows.filter((s) => s.teamId === team.id) : [];
    const show = shows.find((s) => s.id === scope.showId) ?? shows[0] ?? null;
    return {
      teams,
      team,
      allShows,
      shows,
      show,
      showsLoading: showsQ.isLoading,
      setTeam: selectTeam,
      setShow: (showId: string) => {
        const s = allShows.find((x) => x.id === showId);
        if (s) selectShow(s);
      },
      canManageTeam: isManager(team?.role),
      canWriteShow: show?.access === 'manage' || show?.access === 'write',
    };
  }, [teams, allShows, scope.teamId, scope.showId, showsQ.isLoading]);
}
