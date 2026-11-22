// tokens.* — the user's agent credentials: personal access tokens and OAuth grants.
// Secrets are never returned except the PAT plaintext once, on creation.

import type { ApiToken } from '@autologger/contract';
import { and, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { notFound } from '../core/errors.ts';
import { defineOp } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { mintPat, revokeGrant } from '../mcp/tokens.ts';
import { iso } from './map.ts';

const { apiTokens, oauthClients } = schema;

const notExpired = or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, sql`now()`));

function patToApi(r: typeof apiTokens.$inferSelect): ApiToken {
  return {
    id: r.id,
    kind: 'pat',
    name: r.name,
    clientName: null,
    prefix: r.prefix,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: iso(r.lastUsedAt),
    expiresAt: iso(r.expiresAt),
  };
}

defineOp({
  name: 'tokens.list',
  description:
    'Your agent credentials: personal access tokens and connected OAuth apps (one row per grant). Secrets are never shown.',
  kind: 'read',
  surfaces: ['web'],
  async run(ctx) {
    const uid = ctx.actor.user.id;
    const pats = await ctx.db
      .select()
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.userId, uid),
          eq(apiTokens.kind, 'pat'),
          isNull(apiTokens.revokedAt),
          notExpired,
        ),
      )
      .orderBy(apiTokens.createdAt);

    // One row per grant; a grant is live while it holds an unrevoked, unexpired token
    // (normally its refresh token). Timestamps cover the whole grant, including rotated tokens.
    const grants = await ctx.db
      .select({
        grantId: apiTokens.grantId,
        clientName: sql<string>`coalesce(max(${oauthClients.name}), max(${apiTokens.name}))`,
        createdAt: sql<Date>`min(${apiTokens.createdAt})`.mapWith(apiTokens.createdAt),
        lastUsedAt: sql<Date | null>`max(${apiTokens.lastUsedAt})`.mapWith(apiTokens.lastUsedAt),
        expiresAt:
          sql<Date | null>`max(${apiTokens.expiresAt}) filter (where ${apiTokens.revokedAt} is null)`.mapWith(
            apiTokens.expiresAt,
          ),
      })
      .from(apiTokens)
      .leftJoin(oauthClients, eq(oauthClients.id, apiTokens.clientId))
      .where(and(eq(apiTokens.userId, uid), isNotNull(apiTokens.grantId)))
      .groupBy(apiTokens.grantId)
      .having(
        sql`bool_or(${apiTokens.revokedAt} is null and (${apiTokens.expiresAt} is null or ${apiTokens.expiresAt} > now()))`,
      );
    const oauth: ApiToken[] = grants.map((g) => ({
      id: g.grantId!,
      kind: 'oauth',
      name: g.clientName,
      clientName: g.clientName,
      prefix: 'OAuth',
      createdAt: g.createdAt.toISOString(),
      lastUsedAt: iso(g.lastUsedAt),
      expiresAt: iso(g.expiresAt),
    }));
    return [...pats.map(patToApi), ...oauth].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
});

defineOp({
  name: 'tokens.createPat',
  description:
    'Create a personal access token for an MCP client. The token is shown once; store it in the client config.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { name, expiresInDays }) {
    const { token, row } = await mintPat(ctx.db, {
      userId: ctx.actor.user.id,
      name,
      expiresInDays,
    });
    return { token, apiToken: patToApi(row) };
  },
});

defineOp({
  name: 'tokens.revoke',
  description:
    'Revoke a personal access token, or disconnect an OAuth app (revokes every token of that grant).',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { tokenId }) {
    const uid = ctx.actor.user.id;
    const [pat] = await ctx.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiTokens.id, tokenId),
          eq(apiTokens.userId, uid),
          eq(apiTokens.kind, 'pat'),
          isNull(apiTokens.revokedAt),
        ),
      )
      .returning({ id: apiTokens.id });
    if (pat) return { revoked: true };
    const [grant] = await ctx.db
      .select({ grantId: apiTokens.grantId })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, uid), eq(apiTokens.grantId, tokenId)))
      .limit(1);
    if (!grant) throw notFound('Token');
    await revokeGrant(ctx.db, tokenId);
    return { revoked: true };
  },
});
