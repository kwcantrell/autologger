// Agent bearer tokens: personal access tokens (`alp_…`) and OAuth access / refresh tokens
// (`alo_…` / `alr_…`). Only SHA-256 hashes are stored. An OAuth grant groups the access and
// refresh tokens issued to one client for one user; revoking it revokes all of them.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { newId, newSecret, sha256 } from '../core/ids.ts';
import type { Actor } from '../core/op.ts';
import { type DbOrTx, db, schema } from '../db/client.ts';
import { ACCESS_TTL_SEC, REFRESH_TTL_SEC, refreshDecision } from './oauth-core.ts';

const { apiTokens, users, oauthClients } = schema;

export const PAT_PREFIX = 'alp';
export const ACCESS_PREFIX = 'alo';
export const REFRESH_PREFIX = 'alr';

const LAST_USED_THROTTLE_MS = 60_000;

/** The non-secret prefix shown in the UI to tell tokens apart. */
const displayPrefix = (token: string) => token.slice(0, 10);

/** Resolve `Authorization: Bearer <token>` to an MCP actor, or null when invalid/revoked/expired. */
export async function actorFromBearer(token: string): Promise<Actor | null> {
  if (!token.startsWith(`${PAT_PREFIX}_`) && !token.startsWith(`${ACCESS_PREFIX}_`)) return null;
  const [row] = await db
    .select({ t: apiTokens, user: users, clientName: oauthClients.name })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .leftJoin(oauthClients, eq(oauthClients.id, apiTokens.clientId))
    .where(
      and(
        eq(apiTokens.tokenHash, sha256(token)),
        inArray(apiTokens.kind, ['pat', 'oauth_access']),
        isNull(apiTokens.revokedAt),
      ),
    );
  if (!row) return null;
  const now = Date.now();
  if (row.t.expiresAt && row.t.expiresAt.getTime() <= now) return null;
  if (row.user.status === 'disabled') return null;
  if (!row.t.lastUsedAt || now - row.t.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    db.update(apiTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(apiTokens.id, row.t.id))
      .catch((e) => console.error('token last_used update failed', e));
  }
  const u = row.user;
  return {
    user: {
      id: u.id,
      email: u.email,
      name: u.name || u.email,
      isSuperadmin: u.isSuperadmin,
      status: u.status,
    },
    via: 'mcp',
    clientName: row.clientName ?? row.t.name,
    tokenId: row.t.id,
    device: null,
  };
}

export type ApiTokenRow = typeof apiTokens.$inferSelect;

/** Create a personal access token. The plaintext is returned once and never stored. */
export async function mintPat(
  tx: DbOrTx,
  p: { userId: string; name: string; expiresInDays?: number },
): Promise<{ token: string; row: ApiTokenRow }> {
  const token = newSecret(PAT_PREFIX);
  const [row] = await tx
    .insert(apiTokens)
    .values({
      id: newId('tok'),
      userId: p.userId,
      kind: 'pat',
      name: p.name,
      tokenHash: sha256(token),
      prefix: displayPrefix(token),
      expiresAt: p.expiresInDays ? new Date(Date.now() + p.expiresInDays * 86400_000) : null,
    })
    .returning();
  return { token, row: row! };
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  grantId: string;
}

/** Issue an access + refresh token pair for an OAuth grant (a new grant unless grantId is given). */
export async function issueGrantTokens(
  tx: DbOrTx,
  p: { userId: string; clientId: string; clientName: string; scope: string; grantId?: string },
): Promise<TokenPair> {
  const grantId = p.grantId ?? newId('grt');
  const accessToken = newSecret(ACCESS_PREFIX);
  const refreshToken = newSecret(REFRESH_PREFIX);
  const now = Date.now();
  const base = {
    userId: p.userId,
    clientId: p.clientId,
    grantId,
    name: p.clientName,
    scope: p.scope,
  };
  await tx.insert(apiTokens).values([
    {
      ...base,
      id: newId('tok'),
      kind: 'oauth_access',
      tokenHash: sha256(accessToken),
      prefix: displayPrefix(accessToken),
      expiresAt: new Date(now + ACCESS_TTL_SEC * 1000),
    },
    {
      ...base,
      id: newId('tok'),
      kind: 'oauth_refresh',
      tokenHash: sha256(refreshToken),
      prefix: displayPrefix(refreshToken),
      expiresAt: new Date(now + REFRESH_TTL_SEC * 1000),
    },
  ]);
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SEC, scope: p.scope, grantId };
}

/** Revoke every live token of a grant. */
export async function revokeGrant(tx: DbOrTx, grantId: string): Promise<number> {
  const rows = await tx
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.grantId, grantId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return rows.length;
}

export type RefreshResult = { ok: true; tokens: TokenPair } | { ok: false; description: string };

/**
 * Exchange a refresh token for a new pair (rotation). Reusing an already-rotated refresh token is
 * treated as theft and revokes the whole grant.
 */
export async function rotateRefreshToken(
  refreshToken: string,
  clientId: string | undefined,
): Promise<RefreshResult> {
  if (!refreshToken.startsWith(`${REFRESH_PREFIX}_`))
    return { ok: false, description: 'Unknown refresh token.' };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ t: apiTokens, user: users, clientName: oauthClients.name })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .leftJoin(oauthClients, eq(oauthClients.id, apiTokens.clientId))
      .where(
        and(eq(apiTokens.tokenHash, sha256(refreshToken)), eq(apiTokens.kind, 'oauth_refresh')),
      )
      .for('update', { of: apiTokens });
    const decision = refreshDecision(row?.t, clientId, new Date());
    if (decision === 'reject_and_revoke_grant' && row?.t.grantId) {
      await revokeGrant(tx, row.t.grantId);
      return {
        ok: false,
        description: 'Refresh token was already used; the grant has been revoked.',
      };
    }
    if (decision !== 'rotate' || !row)
      return { ok: false, description: 'Refresh token is invalid or expired.' };
    if (row.user.status !== 'active')
      return { ok: false, description: 'The account is not active.' };
    await tx
      .update(apiTokens)
      .set({ revokedAt: new Date(), lastUsedAt: new Date() })
      .where(eq(apiTokens.id, row.t.id));
    const tokens = await issueGrantTokens(tx, {
      userId: row.t.userId,
      clientId: row.t.clientId!,
      clientName: row.clientName ?? row.t.name,
      scope: row.t.scope,
      grantId: row.t.grantId ?? undefined,
    });
    return { ok: true, tokens };
  });
}

/**
 * RFC 7009 revocation by token value. OAuth tokens revoke their whole grant; PATs revoke
 * themselves. Unknown tokens are ignored (the endpoint always answers 200).
 */
export async function revokeByValue(token: string, clientId?: string): Promise<void> {
  const [row] = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, sha256(token)));
  if (!row || row.revokedAt) return;
  if (row.kind === 'pat') {
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, row.id));
    return;
  }
  if (clientId && row.clientId !== clientId) return;
  if (row.grantId) await revokeGrant(db, row.grantId);
  else await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, row.id));
}
