// Who may do what to a team member:
//   - no control ever targets the owner (ownership moves only by transfer);
//   - only the owner changes roles (Admin / Member);
//   - the owner removes anyone else; an admin removes `member` rows only; nobody removes themself
//     here (leaving is in Team details);
//   - only `member` rows get per-show access: an owner's or admin's role reaches every show.

import type { ShowAccess, TeamMember, TeamRole } from '@autologger/contract';

export { isManager, ROLE_LABEL } from '@/app/useActive';

export interface MemberPermissions {
  changeRole: boolean;
  remove: boolean;
  grantShows: boolean;
}

export function memberPermissions(
  viewer: TeamRole,
  member: Pick<TeamMember, 'userId' | 'role'>,
  selfId?: string | null,
): MemberPermissions {
  const target = member.role !== 'owner';
  const self = Boolean(selfId) && member.userId === selfId;
  const manager = viewer === 'owner' || viewer === 'admin';
  return {
    changeRole: viewer === 'owner' && target && !self,
    remove:
      target && !self && (viewer === 'owner' || (viewer === 'admin' && member.role === 'member')),
    grantShows: manager && member.role === 'member',
  };
}

export const memberLabel = (m: Pick<TeamMember, 'name' | 'email'>) =>
  m.name.trim() || m.email || 'Unnamed member';

export function initials(text: string): string {
  const parts = text
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export const memberInitials = (m: Pick<TeamMember, 'name' | 'email'>) =>
  initials(m.name || m.email);

/** A show name's initials, as the server suggests a code. */
export const showInitials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 12);

export type GrantLevel = 'none' | 'read' | 'write';
export const GRANT_LABEL: Record<GrantLevel, string> = {
  none: 'No access',
  read: 'Read',
  write: 'Write',
};

export function grantOf(member: Pick<TeamMember, 'grants'>, showId: string): GrantLevel {
  const g = member.grants.find((x) => x.showId === showId);
  return !g ? 'none' : g.canWrite ? 'write' : 'read';
}

export const ACCESS_LABEL: Record<ShowAccess, string> = {
  manage: 'Manage',
  write: 'Write',
  read: 'Read',
};
