// Authorization. All checks are explicit calls from op implementations.
//
//   team owner/admin  → 'manage' on every show of the team
//   team member       → 'write' or 'read' on shows they hold a grant for, nothing else
//   superadmin        → 'manage' everywhere
//   companion device  → limited to its own show, never above 'write'
//
// Missing access answers not_found so ids of other teams' data are not confirmed.

import type { ShowAccess, TeamRole } from '@autologger/contract';
import { and, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { forbidden, notFound } from './errors.ts';
import type { Actor, Ctx } from './op.ts';

const { teamMembers, shows, showGrants, sessions } = schema;

const ROLE_RANK: Record<TeamRole, number> = { member: 1, admin: 2, owner: 3 };
const ACCESS_RANK: Record<ShowAccess, number> = { read: 1, write: 2, manage: 3 };

export async function teamRole(ctx: Ctx, teamId: string): Promise<TeamRole | null> {
  const [row] = await ctx.db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, ctx.actor.user.id)));
  if (row) return row.role;
  return ctx.actor.user.isSuperadmin ? 'admin' : null;
}

export async function requireTeamRole(ctx: Ctx, teamId: string, min: TeamRole): Promise<TeamRole> {
  if (ctx.actor.device) throw forbidden();
  const role = await teamRole(ctx, teamId);
  if (!role) throw notFound('Team');
  if (ROLE_RANK[role] < ROLE_RANK[min]) throw forbidden(`This needs the ${min} role.`);
  return role;
}

export type ShowRow = typeof shows.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

export async function showAccess(ctx: Ctx, show: ShowRow): Promise<ShowAccess | null> {
  let access: ShowAccess | null = null;
  if (ctx.actor.user.isSuperadmin) access = 'manage';
  else {
    const [m] = await ctx.db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, show.teamId), eq(teamMembers.userId, ctx.actor.user.id)));
    if (m && (m.role === 'owner' || m.role === 'admin')) access = 'manage';
    else if (m) {
      const [g] = await ctx.db
        .select({ canWrite: showGrants.canWrite })
        .from(showGrants)
        .where(and(eq(showGrants.showId, show.id), eq(showGrants.userId, ctx.actor.user.id)));
      if (g) access = g.canWrite ? 'write' : 'read';
    }
  }
  if (ctx.actor.device) {
    if (ctx.actor.device.showId !== show.id) return null;
    if (access === 'manage') access = 'write';
  }
  return access;
}

export async function requireShow(
  ctx: Ctx,
  showId: string,
  need: ShowAccess,
): Promise<{ show: ShowRow; access: ShowAccess }> {
  const [show] = await ctx.db.select().from(shows).where(eq(shows.id, showId));
  if (!show) throw notFound('Show');
  const access = await showAccess(ctx, show);
  if (!access) throw notFound('Show');
  if (ACCESS_RANK[access] < ACCESS_RANK[need]) {
    throw forbidden(
      need === 'manage'
        ? 'Only team owners and admins can do this.'
        : 'You have read-only access to this show.',
    );
  }
  return { show, access };
}

export async function requireSession(
  ctx: Ctx,
  sessionId: string,
  need: ShowAccess,
): Promise<{ session: SessionRow; show: ShowRow; access: ShowAccess }> {
  const [session] = await ctx.db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) throw notFound('Session');
  try {
    const { show, access } = await requireShow(ctx, session.showId, need);
    return { session, show, access };
  } catch (e) {
    if ((e as { code?: string }).code === 'not_found') throw notFound('Session');
    throw e;
  }
}

/**
 * Access check outside an op (WebSocket handshakes and re-checks): true when the actor can read
 * the session. The checks above only use ctx.actor and ctx.db, so no op context is needed.
 */
export async function canReadSession(actor: Actor, sessionId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const ctx = { actor, db: tx } as Pick<Ctx, 'actor' | 'db'> as Ctx;
    return requireSession(ctx, sessionId, 'read').then(
      () => true,
      () => false,
    );
  });
}

/**
 * SQL condition selecting the shows the actor can read; pass the show id column to filter on.
 * Used by list and search queries.
 */
export function readableShowCondition(
  ctx: Ctx,
  showIdCol: SQL.Aliased | typeof shows.id | typeof sessions.showId | SQL,
): SQL {
  if (ctx.actor.device) return sql`${showIdCol} = ${ctx.actor.device.showId}`;
  if (ctx.actor.user.isSuperadmin) return sql`true`;
  const uid = ctx.actor.user.id;
  return sql`${showIdCol} in (
    select s.id from shows s join team_members m on m.team_id = s.team_id and m.user_id = ${uid}
      where m.role in ('owner','admin')
    union
    select g.show_id from show_grants g
      join shows s2 on s2.id = g.show_id
      join team_members m2 on m2.team_id = s2.team_id and m2.user_id = ${uid}
      where g.user_id = ${uid}
  )`;
}

/** Access level for many shows at once (for list ops). */
export async function showAccessMap(
  ctx: Ctx,
  showRows: ShowRow[],
): Promise<Map<string, ShowAccess>> {
  const out = new Map<string, ShowAccess>();
  if (showRows.length === 0) return out;
  const teamIds = [...new Set(showRows.map((s) => s.teamId))];
  const roles = await ctx.db
    .select({ teamId: teamMembers.teamId, role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, ctx.actor.user.id), inArray(teamMembers.teamId, teamIds)));
  const roleByTeam = new Map(roles.map((r) => [r.teamId, r.role]));
  const grants = await ctx.db
    .select({ showId: showGrants.showId, canWrite: showGrants.canWrite })
    .from(showGrants)
    .where(
      and(
        eq(showGrants.userId, ctx.actor.user.id),
        or(...showRows.map((s) => eq(showGrants.showId, s.id))),
      ),
    );
  const grantByShow = new Map(grants.map((g) => [g.showId, g.canWrite]));
  for (const s of showRows) {
    const role = roleByTeam.get(s.teamId);
    let a: ShowAccess | null = null;
    if (ctx.actor.user.isSuperadmin || role === 'owner' || role === 'admin') a = 'manage';
    else if (role && grantByShow.has(s.id)) a = grantByShow.get(s.id) ? 'write' : 'read';
    if (ctx.actor.device)
      a = ctx.actor.device.showId === s.id && a ? (a === 'manage' ? 'write' : a) : null;
    if (a) out.set(s.id, a);
  }
  return out;
}

export function requireSuperadmin(ctx: Ctx): void {
  if (!ctx.actor.user.isSuperadmin || ctx.actor.device)
    throw forbidden('Only instance administrators can do this.');
}
