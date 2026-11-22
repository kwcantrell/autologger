import type { AdminUser } from '@autologger/contract';
import { and, asc, eq, ne } from 'drizzle-orm';
import { requireSuperadmin } from '../core/authz.ts';
import { badRequest, notFound } from '../core/errors.ts';
import { type Ctx, defineOp } from '../core/op.ts';
import { schema } from '../db/client.ts';

const { users, teams, teamMembers, authSessions } = schema;

async function loadUsers(ctx: Ctx, userId?: string): Promise<AdminUser[]> {
  const rows = await ctx.db.select().from(users).where(userId ? eq(users.id, userId) : undefined).orderBy(asc(users.status), asc(users.email));
  const memberships = await ctx.db
    .select({ userId: teamMembers.userId, id: teams.id, name: teams.name, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId));
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status,
    isSuperadmin: u.isSuperadmin,
    createdAt: u.createdAt.toISOString(),
    teams: memberships.filter((m) => m.userId === u.id).map(({ id, name, role }) => ({ id, name, role })),
  }));
}

async function one(ctx: Ctx, userId: string): Promise<AdminUser> {
  const [u] = await loadUsers(ctx, userId);
  if (!u) throw notFound('User');
  return u;
}

defineOp({
  name: 'admin.users',
  description: 'All accounts on this instance (instance admins only).',
  kind: 'read',
  surfaces: ['web'],
  async run(ctx) {
    requireSuperadmin(ctx);
    return loadUsers(ctx);
  },
});

defineOp({
  name: 'admin.setStatus',
  description: 'Approve, disable or re-enable an account (instance admins only).',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { userId, status }) {
    requireSuperadmin(ctx);
    if (userId === ctx.actor.user.id && status !== 'active') throw badRequest('You cannot disable your own account.');
    await one(ctx, userId);
    await ctx.db.update(users).set({ status }).where(eq(users.id, userId));
    if (status === 'disabled') {
      await ctx.db.delete(authSessions).where(eq(authSessions.userId, userId));
      await ctx.db.update(schema.apiTokens).set({ revokedAt: new Date() }).where(eq(schema.apiTokens.userId, userId));
      ctx.publish(`user:${userId}`, { type: 'access_changed', userId });
    }
    return one(ctx, userId);
  },
});

defineOp({
  name: 'admin.setSuperadmin',
  description: 'Grant or remove instance-admin rights (instance admins only).',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { userId, value }) {
    requireSuperadmin(ctx);
    if (!value) {
      const others = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.isSuperadmin, true), ne(users.id, userId)));
      if (others.length === 0) throw badRequest('At least one instance admin must remain.');
    }
    await one(ctx, userId);
    await ctx.db.update(users).set({ isSuperadmin: value, ...(value ? { status: 'active' as const } : {}) }).where(eq(users.id, userId));
    return one(ctx, userId);
  },
});
