import type { Me, Team, TeamDetail } from '@autologger/contract';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { requireTeamRole } from '../core/authz.ts';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { iso } from './map.ts';

const { teams, teamMembers, teamInvites, users, showGrants, shows } = schema;
const normEmail = (e: string) => e.trim().toLowerCase();

async function myTeams(ctx: Ctx): Promise<Team[]> {
  const rows = await ctx.db
    .select({ id: teams.id, name: teams.name, createdAt: teams.createdAt, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, ctx.actor.user.id))
    .orderBy(asc(teams.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function loadMe(ctx: Ctx): Promise<Me> {
  const [u] = await ctx.db.select().from(users).where(eq(users.id, ctx.actor.user.id));
  if (!u) throw notFound('User');
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    pictureUrl: u.pictureUrl,
    status: u.status,
    isSuperadmin: u.isSuperadmin,
    teams: await myTeams(ctx),
  };
}

async function teamDetail(ctx: Ctx, teamId: string): Promise<TeamDetail> {
  const role = await requireTeamRole(ctx, teamId, 'member');
  const [t] = await ctx.db.select().from(teams).where(eq(teams.id, teamId));
  if (!t) throw notFound('Team');
  const members = await ctx.db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      pictureUrl: users.pictureUrl,
      role: teamMembers.role,
      joinedAt: teamMembers.joinedAt,
    })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(asc(users.name));
  const grants = await ctx.db
    .select({ userId: showGrants.userId, showId: showGrants.showId, canWrite: showGrants.canWrite })
    .from(showGrants)
    .innerJoin(shows, eq(shows.id, showGrants.showId))
    .where(eq(shows.teamId, teamId));
  const invites = await ctx.db
    .select({
      email: teamInvites.email,
      role: teamInvites.role,
      invitedAt: teamInvites.invitedAt,
      invitedBy: teamInvites.invitedBy,
      inviterName: users.name,
    })
    .from(teamInvites)
    .leftJoin(users, eq(users.id, teamInvites.invitedBy))
    .where(eq(teamInvites.teamId, teamId));
  const canSeeEmails = role !== 'member';
  return {
    id: t.id,
    name: t.name,
    role,
    createdAt: t.createdAt.toISOString(),
    members: members.map((m) => ({
      userId: m.userId,
      email: canSeeEmails || m.userId === ctx.actor.user.id ? m.email : '',
      name: m.name || m.email,
      pictureUrl: m.pictureUrl,
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
      grants: grants
        .filter((g) => g.userId === m.userId)
        .map((g) => ({ showId: g.showId, canWrite: g.canWrite })),
    })),
    invites: canSeeEmails
      ? invites.map((i) => ({
          email: i.email,
          role: i.role,
          invitedAt: iso(i.invitedAt)!,
          invitedBy: i.invitedBy ? { id: i.invitedBy, name: i.inviterName ?? '' } : null,
        }))
      : [],
  };
}

defineOp({
  name: 'me.get',
  description: 'The signed-in user, their approval status and their teams.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  allowPending: true,
  run: (ctx) => loadMe(ctx),
});

defineOp({
  name: 'me.update',
  description: 'Update your display name.',
  kind: 'write',
  surfaces: ['web'],
  allowPending: true,
  async run(ctx, input) {
    if (input.name)
      await ctx.db.update(users).set({ name: input.name }).where(eq(users.id, ctx.actor.user.id));
    return loadMe(ctx);
  },
});

defineOp({
  name: 'teams.list',
  description: 'Teams you belong to, with your role in each.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  run: (ctx) => myTeams(ctx),
});

defineOp({
  name: 'teams.get',
  description: 'A team with its members, their show grants and pending invites.',
  kind: 'read',
  surfaces: ['web'],
  run: (ctx, { teamId }) => teamDetail(ctx, teamId),
});

defineOp({
  name: 'teams.create',
  description:
    'Create a new team (the top level of teams → shows → sessions); the signed-in user becomes its owner. Returns the team with its id (prefix team_) — pass it as teamId to shows_create to add a show. Use only when asked for a new team; check teams_list first so you do not create a duplicate (names need not be unique). Does not switch the active team in the web app, invite anyone or create shows; member management is web-only. Accounts still waiting for approval cannot create teams (forbidden).',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { name }) {
    const id = newId('team');
    const [t] = await ctx.db.insert(teams).values({ id, name }).returning();
    await ctx.db
      .insert(teamMembers)
      .values({ teamId: id, userId: ctx.actor.user.id, role: 'owner' });
    return { id, name, role: 'owner', createdAt: t!.createdAt.toISOString() };
  },
});

defineOp({
  name: 'teams.rename',
  description: 'Rename a team (owner/admin).',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { teamId, name }) {
    const role = await requireTeamRole(ctx, teamId, 'admin');
    const [t] = await ctx.db.update(teams).set({ name }).where(eq(teams.id, teamId)).returning();
    return { id: teamId, name, role, createdAt: t!.createdAt.toISOString() };
  },
});

defineOp({
  name: 'teams.delete',
  description: 'Delete a team and all its shows and sessions (owner only).',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { teamId }) {
    await requireTeamRole(ctx, teamId, 'owner');
    const members = await ctx.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId));
    await ctx.db.delete(teams).where(eq(teams.id, teamId));
    for (const m of members)
      ctx.publish(`user:${m.userId}`, { type: 'access_changed', userId: m.userId });
    return { deleted: true };
  },
});

defineOp({
  name: 'teams.invite',
  description: 'Invite someone by email. If they already have an account they join immediately.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { teamId, email, role }) {
    await requireTeamRole(ctx, teamId, 'admin');
    const e = normEmail(email);
    const [existing] = await ctx.db.select().from(users).where(eq(users.email, e));
    if (existing) {
      await ctx.db
        .insert(teamMembers)
        .values({ teamId, userId: existing.id, role })
        .onConflictDoNothing();
      if (existing.status === 'pending') {
        await ctx.db.update(users).set({ status: 'active' }).where(eq(users.id, existing.id));
      }
    } else {
      await ctx.db
        .insert(teamInvites)
        .values({ teamId, email: e, role, invitedBy: ctx.actor.user.id })
        .onConflictDoUpdate({ target: [teamInvites.teamId, teamInvites.email], set: { role } });
    }
    return teamDetail(ctx, teamId);
  },
});

defineOp({
  name: 'teams.revokeInvite',
  description: 'Cancel a pending invite.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { teamId, email }) {
    await requireTeamRole(ctx, teamId, 'admin');
    await ctx.db
      .delete(teamInvites)
      .where(and(eq(teamInvites.teamId, teamId), eq(teamInvites.email, normEmail(email))));
    return teamDetail(ctx, teamId);
  },
});

async function memberRole(ctx: Ctx, teamId: string, userId: string) {
  const [m] = await ctx.db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  if (!m) throw notFound('Member');
  return m.role;
}

defineOp({
  name: 'teams.setRole',
  description: 'Change a member between admin and member.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { teamId, userId, role }) {
    const mine = await requireTeamRole(ctx, teamId, 'admin');
    const theirs = await memberRole(ctx, teamId, userId);
    if (theirs === 'owner')
      throw badRequest('Transfer ownership instead of changing the owner’s role.');
    if (mine === 'admin' && theirs === 'admin' && userId !== ctx.actor.user.id) {
      throw forbidden('Only the owner can change another admin.');
    }
    await ctx.db
      .update(teamMembers)
      .set({ role })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    ctx.publish(`user:${userId}`, { type: 'access_changed', userId });
    return teamDetail(ctx, teamId);
  },
});

defineOp({
  name: 'teams.removeMember',
  description: 'Remove a member from the team. Their show grants go with them.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { teamId, userId }) {
    const mine = await requireTeamRole(ctx, teamId, 'admin');
    const theirs = await memberRole(ctx, teamId, userId);
    if (theirs === 'owner') throw badRequest('The owner cannot be removed.');
    if (theirs === 'admin' && mine !== 'owner')
      throw forbidden('Only the owner can remove an admin.');
    await removeMembership(ctx, teamId, userId);
    return teamDetail(ctx, teamId);
  },
});

async function removeMembership(ctx: Ctx, teamId: string, userId: string) {
  await ctx.db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  const teamShows = ctx.db.select({ id: shows.id }).from(shows).where(eq(shows.teamId, teamId));
  await ctx.db
    .delete(showGrants)
    .where(and(eq(showGrants.userId, userId), inArray(showGrants.showId, teamShows)));
  ctx.publish(`user:${userId}`, { type: 'access_changed', userId });
}

defineOp({
  name: 'teams.leave',
  description: 'Leave a team. The owner must transfer ownership first.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { teamId }) {
    const role = await memberRole(ctx, teamId, ctx.actor.user.id);
    if (role === 'owner') throw conflict('Transfer ownership before leaving the team.');
    await removeMembership(ctx, teamId, ctx.actor.user.id);
    return { left: true };
  },
});

defineOp({
  name: 'teams.transferOwnership',
  description: 'Make another member the owner; you become an admin.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { teamId, userId }) {
    await requireTeamRole(ctx, teamId, 'owner');
    await memberRole(ctx, teamId, userId);
    if (userId === ctx.actor.user.id) return teamDetail(ctx, teamId);
    await ctx.db
      .update(teamMembers)
      .set({ role: 'admin' })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, 'owner')));
    await ctx.db
      .update(teamMembers)
      .set({ role: 'owner' })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    ctx.publish(`user:${userId}`, { type: 'access_changed', userId });
    return teamDetail(ctx, teamId);
  },
});

defineOp({
  name: 'teams.setGrant',
  description: 'Give a member read or write access to one show, or remove it.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { teamId, userId, showId, access }) {
    await requireTeamRole(ctx, teamId, 'admin');
    await memberRole(ctx, teamId, userId);
    const [show] = await ctx.db
      .select()
      .from(shows)
      .where(and(eq(shows.id, showId), eq(shows.teamId, teamId)));
    if (!show) throw notFound('Show');
    if (access === 'none') {
      await ctx.db
        .delete(showGrants)
        .where(and(eq(showGrants.showId, showId), eq(showGrants.userId, userId)));
    } else {
      await ctx.db
        .insert(showGrants)
        .values({ showId, userId, canWrite: access === 'write', grantedBy: ctx.actor.user.id })
        .onConflictDoUpdate({
          target: [showGrants.showId, showGrants.userId],
          set: {
            canWrite: access === 'write',
            grantedBy: ctx.actor.user.id,
            grantedAt: new Date(),
          },
        });
    }
    ctx.publish(`user:${userId}`, { type: 'access_changed', userId });
    return teamDetail(ctx, teamId);
  },
});
