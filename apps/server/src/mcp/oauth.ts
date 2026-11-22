// OAuth 2.1 authorization server for MCP clients: discovery metadata, dynamic client
// registration (public clients only), authorization code + PKCE (S256), refresh-token rotation
// and revocation. Consent happens in the SPA (/oauth/consent) through the /api/oauth/* JSON API.

import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { newId, newSecret, sha256 } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { env } from '../env.ts';
import { actorFromSessionToken, SESSION_COOKIE } from '../http/auth.ts';
import {
  CODE_TTL_SEC,
  isValidChallenge,
  normalizeResource,
  REQUEST_TTL_SEC,
  redirectHost,
  redirectUriMatches,
  redirectUriProblem,
  verifyPkce,
  withParams,
} from './oauth-core.ts';
import { issueGrantTokens, revokeByValue, rotateRefreshToken } from './tokens.ts';

const { oauthClients, oauthRequests, oauthCodes } = schema;

export const SCOPE = 'autologger';
export const mcpResource = () => `${env.publicUrl}/mcp`;
export const resourceMetadataUrl = () => `${env.publicUrl}/.well-known/oauth-protected-resource`;

/** Accept the MCP endpoint or the bare origin as resource indicator (RFC 8707). */
function resourceOk(resource: string | undefined | null): boolean {
  if (!resource) return true;
  const r = normalizeResource(resource);
  return r === normalizeResource(mcpResource()) || r === normalizeResource(env.publicUrl);
}

export const oauthRoutes = new Hono();

// Discovery, registration, token and revocation endpoints are called by browser-based MCP
// clients too; none of them use cookies, so open CORS is safe.
const openCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'],
  maxAge: 86400,
});
for (const p of ['/.well-known/*', '/oauth/register', '/oauth/token', '/oauth/revoke'])
  oauthRoutes.use(p, openCors);

// ── discovery ────────────────────────────────────────────────────────────────

const protectedResource = (c: Context) =>
  c.json({
    resource: mcpResource(),
    authorization_servers: [env.publicUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: 'AutoLogger',
  });
oauthRoutes.get('/.well-known/oauth-protected-resource', protectedResource);
oauthRoutes.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

const asMetadata = (c: Context) =>
  c.json({
    issuer: env.publicUrl,
    authorization_endpoint: `${env.publicUrl}/oauth/authorize`,
    token_endpoint: `${env.publicUrl}/oauth/token`,
    registration_endpoint: `${env.publicUrl}/oauth/register`,
    revocation_endpoint: `${env.publicUrl}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  });
oauthRoutes.get('/.well-known/oauth-authorization-server', asMetadata);
oauthRoutes.get('/.well-known/oauth-authorization-server/mcp', asMetadata);

// ── dynamic client registration (RFC 7591) ───────────────────────────────────

const REG_LIMIT = 20;
const REG_WINDOW_MS = 3600_000;
const regHits = new Map<string, number[]>();

function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (fwd) return fwd;
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (regHits.get(ip) ?? []).filter((t) => now - t < REG_WINDOW_MS);
  if (hits.length >= REG_LIMIT) {
    regHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  regHits.set(ip, hits);
  if (regHits.size > 10_000) regHits.clear();
  return false;
}

const regError = (c: Context, error: string, description: string, status: 400 | 429 = 400) =>
  c.json({ error, error_description: description }, status);

oauthRoutes.post('/oauth/register', async (c) => {
  if (rateLimited(clientIp(c)))
    return regError(c, 'invalid_request', 'Too many registrations; try again later.', 429);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object')
    return regError(c, 'invalid_client_metadata', 'Body must be a JSON object.');
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 20) {
    return regError(c, 'invalid_redirect_uri', 'redirect_uris must list 1–20 URIs.');
  }
  for (const u of uris) {
    const problem = redirectUriProblem(u);
    if (problem)
      return regError(
        c,
        'invalid_redirect_uri',
        `Redirect URI ${String(u).slice(0, 200)} ${problem}.`,
      );
  }
  const grantTypes = (body.grant_types as unknown) ?? ['authorization_code', 'refresh_token'];
  if (
    !Array.isArray(grantTypes) ||
    grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')
  ) {
    return regError(
      c,
      'invalid_client_metadata',
      'Only authorization_code and refresh_token grants are supported.',
    );
  }
  const responseTypes = (body.response_types as unknown) ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) {
    return regError(c, 'invalid_client_metadata', 'Only the code response type is supported.');
  }
  const name =
    (typeof body.client_name === 'string' && body.client_name.trim().slice(0, 100)) || 'MCP client';
  const id = newId('cli');
  const metadata = {
    client_uri: typeof body.client_uri === 'string' ? body.client_uri.slice(0, 500) : undefined,
    software_id: typeof body.software_id === 'string' ? body.software_id.slice(0, 200) : undefined,
    software_version:
      typeof body.software_version === 'string' ? body.software_version.slice(0, 100) : undefined,
    registered_from: clientIp(c),
  };
  const [row] = await db
    .insert(oauthClients)
    .values({ id, name, redirectUris: uris as string[], metadata })
    .returning();
  return c.json(
    {
      client_id: id,
      client_id_issued_at: Math.floor(row!.createdAt.getTime() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    },
    201,
  );
});

// ── authorization endpoint ───────────────────────────────────────────────────

function errorPage(c: Context, message: string) {
  const esc = message.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Authorization error</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>Can’t connect this app</h1><p>${esc}</p></body>`,
    400,
  );
}

oauthRoutes.get('/oauth/authorize', async (c) => {
  const q = c.req.query();
  const clientId = q.client_id;
  if (!clientId) return errorPage(c, 'The request is missing client_id.');
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId));
  if (!client)
    return errorPage(
      c,
      'This app is not registered with AutoLogger. Remove the connector and add it again.',
    );

  let redirectUri = q.redirect_uri;
  if (!redirectUri) {
    if (client.redirectUris.length !== 1)
      return errorPage(c, 'The request is missing redirect_uri.');
    redirectUri = client.redirectUris[0]!;
  }
  if (!redirectUriMatches(client.redirectUris, redirectUri)) {
    return errorPage(c, 'The redirect_uri does not match any URI registered for this app.');
  }

  // From here on, errors go back to the client.
  const fail = (error: string, description: string) =>
    c.redirect(
      withParams(redirectUri, {
        error,
        error_description: description,
        state: q.state,
        iss: env.publicUrl,
      }),
    );
  if (q.response_type !== 'code')
    return fail('unsupported_response_type', 'response_type must be code.');
  if (!isValidChallenge(q.code_challenge))
    return fail('invalid_request', 'A valid S256 code_challenge is required (PKCE).');
  if (q.code_challenge_method !== 'S256')
    return fail('invalid_request', 'code_challenge_method must be S256.');
  if (!resourceOk(q.resource)) return fail('invalid_target', `resource must be ${mcpResource()}.`);
  const requested = (q.scope ?? '').split(/\s+/).filter(Boolean);
  if (requested.some((s) => s !== SCOPE))
    return fail('invalid_scope', `The only scope is "${SCOPE}".`);

  await db.delete(oauthRequests).where(lt(oauthRequests.expiresAt, new Date()));
  const id = newId('oar', 20);
  await db.insert(oauthRequests).values({
    id,
    clientId: client.id,
    redirectUri,
    codeChallenge: q.code_challenge!,
    state: q.state ?? null,
    scope: SCOPE,
    resource: q.resource ?? null,
    expiresAt: new Date(Date.now() + REQUEST_TTL_SEC * 1000),
  });
  return c.redirect(`${env.publicUrl}/oauth/consent?request=${encodeURIComponent(id)}`);
});

// ── consent API for the SPA (cookie-authenticated) ───────────────────────────

const apiErr = (c: Context, code: string, message: string, status: 400 | 401 | 403 | 404) =>
  c.json({ ok: false, error: { code, message } }, status);

async function consentContext(c: Context) {
  const actor = await actorFromSessionToken(getCookie(c, SESSION_COOKIE));
  if (!actor) return { res: apiErr(c, 'unauthenticated', 'Sign in first.', 401) };
  if (actor.user.status !== 'active') {
    return {
      res: apiErr(
        c,
        'forbidden',
        'Your account is waiting for approval by an administrator. You can connect agents once it is approved.',
        403,
      ),
    };
  }
  const [row] = await db
    .select({ r: oauthRequests, clientName: oauthClients.name })
    .from(oauthRequests)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthRequests.clientId))
    .where(
      and(eq(oauthRequests.id, c.req.param('id') ?? ''), gt(oauthRequests.expiresAt, new Date())),
    );
  if (!row) {
    return {
      res: apiErr(
        c,
        'not_found',
        'This authorization request has expired. Start connecting again from your app.',
        404,
      ),
    };
  }
  return { actor, request: row.r, clientName: row.clientName };
}

oauthRoutes.get('/api/oauth/requests/:id', async (c) => {
  const ctx = await consentContext(c);
  if ('res' in ctx) return ctx.res;
  return c.json({
    ok: true,
    data: {
      clientName: ctx.clientName,
      redirectHost: redirectHost(ctx.request.redirectUri),
      scope: ctx.request.scope,
      expiresAt: ctx.request.expiresAt.toISOString(),
    },
  });
});

oauthRoutes.post('/api/oauth/requests/:id/decision', async (c) => {
  // Cookies are SameSite=Lax, so cross-site POSTs arrive without a session; reject them explicitly too.
  if (c.req.header('sec-fetch-site') === 'cross-site')
    return apiErr(c, 'forbidden', 'Cross-site request.', 403);
  const body = (await c.req.json().catch(() => null)) as { approve?: unknown } | null;
  if (!body || typeof body.approve !== 'boolean')
    return apiErr(c, 'bad_request', 'Body must be {"approve": true|false}.', 400);
  const ctx = await consentContext(c);
  if ('res' in ctx) return ctx.res;
  const { request } = ctx;
  // Single use: whoever deletes the row owns the decision.
  const deleted = await db
    .delete(oauthRequests)
    .where(eq(oauthRequests.id, request.id))
    .returning({ id: oauthRequests.id });
  if (deleted.length === 0)
    return apiErr(c, 'not_found', 'This authorization request was already answered.', 404);

  if (!body.approve) {
    return c.json({
      ok: true,
      data: {
        redirectTo: withParams(request.redirectUri, {
          error: 'access_denied',
          error_description: 'The user declined access.',
          state: request.state,
          iss: env.publicUrl,
        }),
      },
    });
  }
  const code = newSecret('alc');
  await db.insert(oauthCodes).values({
    codeHash: sha256(code),
    clientId: request.clientId,
    userId: ctx.actor.user.id,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scope: request.scope,
    resource: request.resource,
    expiresAt: new Date(Date.now() + CODE_TTL_SEC * 1000),
  });
  return c.json({
    ok: true,
    data: {
      redirectTo: withParams(request.redirectUri, {
        code,
        state: request.state,
        iss: env.publicUrl,
      }),
    },
  });
});

// ── token endpoint ───────────────────────────────────────────────────────────

async function formOrJson(c: Context): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  const out: Record<string, string> = {};
  if (type.includes('application/json')) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body ?? {})) if (typeof v === 'string') out[k] = v;
  } else {
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function tokenError(c: Context, error: string, description: string, status: 400 | 401 = 400) {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({ error, error_description: description }, status);
}

oauthRoutes.post('/oauth/token', async (c) => {
  const p = await formOrJson(c);
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  if (p.grant_type === 'authorization_code') {
    if (!p.code || !p.code_verifier || !p.redirect_uri || !p.client_id) {
      return tokenError(
        c,
        'invalid_request',
        'code, code_verifier, redirect_uri and client_id are required.',
      );
    }
    const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, p.client_id));
    if (!client) return tokenError(c, 'invalid_client', 'Unknown client_id.', 401);
    // Mark the code used atomically; a second exchange finds nothing.
    const [code] = await db
      .update(oauthCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(oauthCodes.codeHash, sha256(p.code)), isNull(oauthCodes.usedAt)))
      .returning();
    if (!code || code.expiresAt <= new Date())
      return tokenError(c, 'invalid_grant', 'The authorization code is invalid, used or expired.');
    if (code.clientId !== client.id)
      return tokenError(c, 'invalid_grant', 'The code was issued to another client.');
    if (code.redirectUri !== p.redirect_uri)
      return tokenError(
        c,
        'invalid_grant',
        'redirect_uri does not match the authorization request.',
      );
    if (!verifyPkce(p.code_verifier, code.codeChallenge))
      return tokenError(c, 'invalid_grant', 'PKCE verification failed.');
    if (
      p.resource &&
      (!resourceOk(p.resource) ||
        (code.resource && normalizeResource(code.resource) !== normalizeResource(p.resource)))
    ) {
      return tokenError(c, 'invalid_target', 'resource does not match the authorization request.');
    }
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, code.userId));
    if (user?.status !== 'active')
      return tokenError(c, 'invalid_grant', 'The account is not active.');
    const t = await db.transaction((tx) =>
      issueGrantTokens(tx, {
        userId: user.id,
        clientId: client.id,
        clientName: client.name,
        scope: code.scope || SCOPE,
      }),
    );
    return c.json({
      access_token: t.accessToken,
      token_type: 'Bearer',
      expires_in: t.expiresIn,
      refresh_token: t.refreshToken,
      scope: t.scope,
    });
  }

  if (p.grant_type === 'refresh_token') {
    if (!p.refresh_token) return tokenError(c, 'invalid_request', 'refresh_token is required.');
    if (p.resource && !resourceOk(p.resource))
      return tokenError(c, 'invalid_target', `resource must be ${mcpResource()}.`);
    const r = await rotateRefreshToken(p.refresh_token, p.client_id);
    if (!r.ok) return tokenError(c, 'invalid_grant', r.description);
    return c.json({
      access_token: r.tokens.accessToken,
      token_type: 'Bearer',
      expires_in: r.tokens.expiresIn,
      refresh_token: r.tokens.refreshToken,
      scope: r.tokens.scope,
    });
  }

  return tokenError(
    c,
    'unsupported_grant_type',
    'grant_type must be authorization_code or refresh_token.',
  );
});

// ── revocation (RFC 7009) ────────────────────────────────────────────────────

oauthRoutes.post('/oauth/revoke', async (c) => {
  const p = await formOrJson(c);
  if (!p.token) return tokenError(c, 'invalid_request', 'token is required.');
  await revokeByValue(p.token, p.client_id);
  c.header('Cache-Control', 'no-store');
  return c.body(null, 200);
});
