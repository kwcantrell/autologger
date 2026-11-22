// Human sign-in: Google OAuth (or dev email login) → DB-backed session cookie.

import { decodeIdToken, Google, generateCodeVerifier, generateState } from 'arctic';
import { and, count, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { newId, newSecret, sha256 } from '../core/ids.ts';
import type { Actor } from '../core/op.ts';
import { db, schema } from '../db/client.ts';
import { env, googleConfigured, isProd } from '../env.ts';

const { users, authSessions, teamInvites, teamMembers } = schema;

export const SESSION_COOKIE = 'al_session';
const SESSION_DAYS = 30;

const google = googleConfigured
  ? new Google(
      env.google.clientId!,
      env.google.clientSecret!,
      `${env.publicUrl}/auth/google/callback`,
    )
  : null;

const cookieOpts = (maxAgeSec: number) => ({
  httpOnly: true,
  secure: isProd || env.publicUrl.startsWith('https://'),
  sameSite: 'Lax' as const,
  path: '/',
  maxAge: maxAgeSec,
});

/** Only same-site relative paths are allowed as post-login destinations. */
export function safeReturn(path: string | undefined | null): string {
  return path?.startsWith('/') && !path.startsWith('//') ? path : '/';
}

/**
 * Create or update the user for a verified email and apply bootstrap rules:
 * the first account ever, and SUPERADMIN_EMAILS, become active superadmins; a pending team
 * invite approves the account and joins the team; everyone else waits for approval.
 */
export async function upsertUser(p: {
  email: string;
  name: string;
  pictureUrl?: string | null;
  googleSub?: string;
}) {
  const email = p.email.trim().toLowerCase();
  return db.transaction(async (tx) => {
    let [user] = await tx.select().from(users).where(eq(users.email, email));
    if (!user) {
      const [{ n }] = (await tx.select({ n: count() }).from(users)) as [{ n: number }];
      const boot = n === 0 || env.superadminEmails.includes(email);
      [user] = await tx
        .insert(users)
        .values({
          id: newId('usr'),
          email,
          name: p.name || email.split('@')[0]!,
          pictureUrl: p.pictureUrl ?? null,
          googleSub: p.googleSub ?? null,
          status: boot ? 'active' : 'pending',
          isSuperadmin: boot,
        })
        .returning();
    } else {
      [user] = await tx
        .update(users)
        .set({
          lastLoginAt: new Date(),
          ...(p.googleSub && !user.googleSub ? { googleSub: p.googleSub } : {}),
          ...(p.pictureUrl ? { pictureUrl: p.pictureUrl } : {}),
          ...(env.superadminEmails.includes(email)
            ? { isSuperadmin: true, status: 'active' as const }
            : {}),
        })
        .where(eq(users.id, user.id))
        .returning();
    }
    const invites = await tx.select().from(teamInvites).where(eq(teamInvites.email, email));
    for (const inv of invites) {
      await tx
        .insert(teamMembers)
        .values({ teamId: inv.teamId, userId: user!.id, role: inv.role })
        .onConflictDoNothing();
      await tx
        .delete(teamInvites)
        .where(and(eq(teamInvites.teamId, inv.teamId), eq(teamInvites.email, email)));
    }
    if (invites.length && user!.status === 'pending') {
      [user] = await tx
        .update(users)
        .set({ status: 'active' })
        .where(eq(users.id, user!.id))
        .returning();
    }
    return user!;
  });
}

export async function createAuthSession(userId: string, userAgent?: string): Promise<string> {
  const token = newSecret('als');
  await db.insert(authSessions).values({
    idHash: sha256(token),
    userId,
    userAgent: userAgent?.slice(0, 300) ?? null,
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000),
  });
  return token;
}

/** Resolve a session cookie value to an actor (or null). */
export async function actorFromSessionToken(token: string | undefined): Promise<Actor | null> {
  if (!token) return null;
  const [row] = await db
    .select({ user: users })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.idHash, sha256(token)), gt(authSessions.expiresAt, new Date())));
  if (!row || row.user.status === 'disabled') return null;
  const u = row.user;
  return {
    user: {
      id: u.id,
      email: u.email,
      name: u.name || u.email,
      isSuperadmin: u.isSuperadmin,
      status: u.status,
    },
    via: 'web',
    clientName: null,
    tokenId: null,
    device: null,
  };
}

/** Parse the session cookie from a raw Cookie header (used by WebSocket upgrades). */
export function sessionTokenFromCookieHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export const authRoutes = new Hono();

authRoutes.get('/auth/google/start', (c) => {
  if (!google) return c.text('Google sign-in is not configured on this server.', 503);
  const state = generateState();
  const verifier = generateCodeVerifier();
  const url = google.createAuthorizationURL(state, verifier, ['openid', 'email', 'profile']);
  url.searchParams.set('prompt', 'select_account');
  setCookie(c, 'al_oauth_state', state, cookieOpts(600));
  setCookie(c, 'al_oauth_verifier', verifier, cookieOpts(600));
  setCookie(c, 'al_return', safeReturn(c.req.query('return')), cookieOpts(600));
  return c.redirect(url.toString());
});

authRoutes.get('/auth/google/callback', async (c) => {
  if (!google) return c.text('Google sign-in is not configured on this server.', 503);
  const state = c.req.query('state');
  const code = c.req.query('code');
  const verifier = getCookie(c, 'al_oauth_verifier');
  if (!state || !code || !verifier || state !== getCookie(c, 'al_oauth_state')) {
    return c.redirect('/login?error=state');
  }
  try {
    const tokens = await google.validateAuthorizationCode(code, verifier);
    const claims = decodeIdToken(tokens.idToken()) as {
      sub: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };
    if (!claims.email || claims.email_verified === false) return c.redirect('/login?error=email');
    const user = await upsertUser({
      email: claims.email,
      name: claims.name ?? '',
      pictureUrl: claims.picture,
      googleSub: claims.sub,
    });
    if (user.status === 'disabled') return c.redirect('/login?error=disabled');
    const token = await createAuthSession(user.id, c.req.header('user-agent'));
    setCookie(c, SESSION_COOKIE, token, cookieOpts(SESSION_DAYS * 86400));
    const ret = safeReturn(getCookie(c, 'al_return'));
    for (const k of ['al_oauth_state', 'al_oauth_verifier', 'al_return'])
      deleteCookie(c, k, { path: '/' });
    return c.redirect(ret);
  } catch (e) {
    console.error('google callback failed', e);
    return c.redirect('/login?error=google');
  }
});

authRoutes.post('/auth/dev-login', async (c) => {
  if (!env.devLogin || isProd)
    return c.json({ ok: false, error: { code: 'not_found', message: 'Not found.' } }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; name?: string };
  if (!body.email || !/^[^@\s]+@[^@\s]+$/.test(body.email)) {
    return c.json(
      { ok: false, error: { code: 'bad_request', message: 'Enter an email address.' } },
      400,
    );
  }
  const user = await upsertUser({ email: body.email, name: body.name ?? '' });
  if (user.status === 'disabled')
    return c.json(
      { ok: false, error: { code: 'forbidden', message: 'This account is disabled.' } },
      403,
    );
  const token = await createAuthSession(user.id, c.req.header('user-agent'));
  setCookie(c, SESSION_COOKIE, token, cookieOpts(SESSION_DAYS * 86400));
  return c.json({ ok: true, data: { userId: user.id } });
});

authRoutes.post('/auth/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await db.delete(authSessions).where(eq(authSessions.idHash, sha256(token)));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true, data: null });
});
