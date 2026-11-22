// Pure OAuth helpers (no DB, no env) so they can be unit-tested in isolation.

import { createHash, timingSafeEqual } from 'node:crypto';

/** RFC 7636 S256: BASE64URL(SHA256(ascii(code_verifier))) === code_challenge. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

export function isValidChallenge(challenge: string | undefined | null): boolean {
  return typeof challenge === 'string' && CHALLENGE_RE.test(challenge);
}

export function verifyPkce(verifier: string | undefined | null, challenge: string): boolean {
  if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) return false;
  const a = Buffer.from(pkceChallenge(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'about:',
  'blob:',
  'ws:',
  'wss:',
  'ftp:',
]);

/**
 * Redirect URIs a public client may register: https, http on a loopback host, or a private-use
 * scheme such as `claude://` (native apps, RFC 8252). No fragments.
 */
export function redirectUriProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000)
    return 'must be a non-empty string';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'is not an absolute URI';
  }
  if (u.hash || raw.includes('#')) return 'must not contain a fragment';
  if (u.protocol === 'https:') return u.hostname ? null : 'needs a host';
  if (u.protocol === 'http:')
    return LOOPBACK.has(u.hostname) ? null : 'http is only allowed for localhost / 127.0.0.1';
  if (FORBIDDEN_SCHEMES.has(u.protocol)) return `scheme ${u.protocol} is not allowed`;
  if (/^[a-z][a-z0-9+.-]*:$/.test(u.protocol)) return null;
  return 'has an unsupported scheme';
}

function isLoopbackHttp(u: URL): boolean {
  return u.protocol === 'http:' && LOOPBACK.has(u.hostname);
}

/**
 * Exact string match against a registered URI, except that loopback redirects may use any port
 * (RFC 8252 §7.3: native apps bind an ephemeral port).
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackHttp(req)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return (
        isLoopbackHttp(reg) &&
        reg.hostname === req.hostname &&
        reg.pathname === req.pathname &&
        reg.search === req.search
      );
    } catch {
      return false;
    }
  });
}

/** Append query parameters to a redirect URI, keeping any it already has. */
export function withParams(uri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

/** Display host for the consent screen: `example.com`, `localhost:3333` or `claude://`. */
export function redirectHost(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.host;
    return u.host ? `${u.protocol}//${u.host}` : `${u.protocol}//`;
  } catch {
    return uri;
  }
}

/** Normalise a resource indicator for comparison (no trailing slash). */
export function normalizeResource(r: string): string {
  return r.replace(/\/+$/, '');
}

/** Token lifetimes. */
export const ACCESS_TTL_SEC = 3600;
export const REFRESH_TTL_SEC = 30 * 86400;
export const CODE_TTL_SEC = 60;
export const REQUEST_TTL_SEC = 600;

/**
 * Decide what to do with a presented refresh token (the rotation policy, kept pure for tests).
 * - unknown / wrong client / expired → reject
 * - already revoked → reuse detected: reject AND revoke the whole grant
 * - otherwise → rotate (revoke it, issue a new pair in the same grant)
 */
export type RefreshDecision = 'rotate' | 'reject' | 'reject_and_revoke_grant';
export function refreshDecision(
  row:
    | { clientId: string | null; revokedAt: Date | null; expiresAt: Date | null }
    | null
    | undefined,
  clientId: string | undefined,
  now: Date,
): RefreshDecision {
  if (!row) return 'reject';
  if (clientId && row.clientId !== clientId) return 'reject';
  if (row.revokedAt) return 'reject_and_revoke_grant';
  if (row.expiresAt && row.expiresAt <= now) return 'reject';
  return 'rotate';
}
