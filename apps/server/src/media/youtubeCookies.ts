// A team's YouTube sign-in for the server's yt-dlp: a cookies.txt stored per team
// (team_youtube_cookies), used by every yt-dlp run for the team's shows and refreshed from
// yt-dlp's rotated copy after each run. yt-dlp has no working YouTube account login (YouTube blocks
// username/password and OAuth sign-ins), so cookies from a signed-in browser are the only way.

import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import type { YtCookies } from './youtube.ts';

const { teamYoutubeCookies, shows } = schema;

/**
 * Domains whose cookies yt-dlp needs for YouTube; every other line is dropped before storing. The
 * whole string must be a plain host name, so a domain can never smuggle in tabs or line breaks.
 */
const KEEP_DOMAIN = /^\.?(?:[a-z0-9-]+\.)*(?:youtube|google)\.com$/i;
/** Cookie names: printable ASCII without separators. */
const NAME = /^[\x21-\x7e]+$/;
/** Cookie values and paths: printable ASCII, no control characters, tabs or line breaks. */
const PRINTABLE = /^[\x20-\x7e]*$/;
/** Latest expiry kept (9999-12-31): later ones are clamped, so dates stay valid. */
const MAX_EXPIRES = 253_402_300_799;
/** Cookies that only exist while an account is signed in. */
const SIGNED_IN = new Set(['SID', '__Secure-1PSID', '__Secure-3PSID', 'SAPISID', 'LOGIN_INFO']);
/** The ones whose expiry is the session's: the earliest is reported as expiresAt. */
const SESSION = new Set(['SID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO']);

/** Shown when YouTube signed the cookies out during a run (yt-dlp's copy lost SID/LOGIN_INFO). */
export const SIGNED_OUT_MESSAGE =
  'YouTube signed these cookies out (the sign-in cookies were removed when they were used). Sign in to YouTube in the browser again and set fresh cookies.';

interface Cookie {
  domain: string;
  path: string;
  secure: boolean;
  /** Unix seconds; 0 = session cookie. */
  expires: number;
  name: string;
  value: string;
  httpOnly: boolean;
}

export interface ParsedCookies {
  /** Netscape cookies.txt with only the YouTube and Google lines. */
  text: string;
  count: number;
  expiresAt: Date | null;
}

/** A JSON boolean as cookie exporters write it: true / "true" / 1; anything else is false. */
const bool = (v: unknown) => v === true || v === 1 || (typeof v === 'string' && /^true$/i.test(v));

/** Unix seconds from seconds or milliseconds, clamped to MAX_EXPIRES; 0 when absent or invalid. */
function expiry(v: unknown): number {
  let n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1e11) n /= 1000; // milliseconds
  return Math.min(Math.floor(n), MAX_EXPIRES);
}

/** Netscape cookies.txt lines (`#HttpOnly_` prefixes included), as cookies. */
function fromNetscape(text: string): Cookie[] {
  const out: Cookie[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) {
      line = line.slice('#HttpOnly_'.length);
      httpOnly = true;
    } else if (line.startsWith('#') || !line.trim()) continue;
    const f = line.split('\t');
    if (f.length !== 7) continue;
    out.push({
      domain: f[0]!.trim(),
      path: f[2] || '/',
      secure: f[3]!.toUpperCase() === 'TRUE',
      expires: expiry(f[4]),
      name: f[5]!,
      value: f[6]!,
      httpOnly,
    });
  }
  return out;
}

/** A JSON export (Cookie-Editor, EditThisCookie, browser devtools): an array of cookie objects. */
function fromJson(text: string): Cookie[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  return data.flatMap((c: Record<string, unknown>) => {
    if (!c || typeof c !== 'object' || typeof c.name !== 'string' || typeof c.domain !== 'string')
      return [];
    const hostOnly = c.hostOnly === undefined ? !c.domain.startsWith('.') : bool(c.hostOnly);
    const bare = c.domain.replace(/^\./, '');
    return [
      {
        // The leading dot is what "include subdomains" means in cookies.txt.
        domain: hostOnly ? bare : `.${bare}`,
        path: typeof c.path === 'string' ? c.path : '/',
        secure: bool(c.secure),
        expires: expiry(c.expirationDate ?? c.expires),
        name: c.name,
        value: typeof c.value === 'string' ? c.value : String(c.value ?? ''),
        httpOnly: bool(c.httpOnly),
      },
    ];
  });
}

/**
 * Check and slim down a pasted or uploaded cookie export: Netscape cookies.txt or a JSON array.
 * Keeps the youtube.com / google.com cookies only, with every field validated (lines are rebuilt
 * from them, so nothing else can get into the stored file), and requires a signed-in session among
 * them. Throws an Error with a user-facing message that never quotes a cookie.
 */
export function parseYoutubeCookies(input: string): ParsedCookies {
  const trimmed = input.trim();
  const all = trimmed.startsWith('[') ? fromJson(trimmed) : fromNetscape(trimmed);
  if (!all || all.length === 0)
    throw new Error(
      'That is not a cookie export. Paste a Netscape cookies.txt (e.g. from the "Get cookies.txt LOCALLY" browser extension, or `yt-dlp --cookies-from-browser`) or a JSON cookie export.',
    );
  const now = Date.now() / 1000;
  const youtube = all.filter(
    (c) =>
      KEEP_DOMAIN.test(c.domain) &&
      NAME.test(c.name) &&
      PRINTABLE.test(c.value) &&
      PRINTABLE.test(c.path) &&
      c.path.startsWith('/'),
  );
  const kept = youtube.filter((c) => c.expires === 0 || c.expires > now);
  if (!kept.some((c) => SIGNED_IN.has(c.name)))
    throw new Error(
      youtube.some((c) => SIGNED_IN.has(c.name))
        ? 'These YouTube sign-in cookies have expired. Sign in to YouTube in the browser again and export fresh cookies.'
        : kept.length
          ? 'These cookies are not from a signed-in YouTube session (no SID or LOGIN_INFO cookie). Sign in to YouTube in the browser first, then export the cookies of youtube.com again.'
          : 'No youtube.com cookies found. Export the cookies while on youtube.com, signed in.',
    );
  const expiries = kept.filter((c) => SESSION.has(c.name) && c.expires > 0).map((c) => c.expires);
  const lines = kept.map((c) =>
    [
      `${c.httpOnly ? '#HttpOnly_' : ''}${c.domain}`,
      c.domain.startsWith('.') ? 'TRUE' : 'FALSE',
      c.path,
      c.secure ? 'TRUE' : 'FALSE',
      String(c.expires),
      c.name,
      c.value,
    ].join('\t'),
  );
  return {
    text: `# Netscape HTTP Cookie File\n${lines.join('\n')}\n`,
    count: kept.length,
    expiresAt: expiries.length ? new Date(Math.min(...expiries) * 1000) : null,
  };
}

/**
 * The cookies of a run that yt-dlp wrote back: the parsed file, or signedOut when YouTube removed
 * the sign-in cookies (it answers a signed-out session by deleting them, often without an error).
 */
export function rotatedCookies(refreshed: string): ParsedCookies | 'signedOut' {
  try {
    return parseYoutubeCookies(refreshed);
  } catch {
    return 'signedOut';
  }
}

/** A database error as a log line, without the query's parameters (they hold the cookies). */
export const dbErrorText = (e: unknown) => {
  const err = e as { cause?: { message?: string; code?: string }; message?: string };
  return err.cause?.message ?? err.cause?.code ?? String(err.message ?? e).split('\nparams:')[0];
};

/**
 * The stored cookies of the show's team for a yt-dlp run, or null when the team has none (the
 * run then uses YTDLP_COOKIES_FILE, if set). After the run, the outcome is recorded on the row
 * and yt-dlp's rotated cookies replace the stored ones, unless someone set new cookies meanwhile.
 */
export async function youtubeCookiesForShow(showId: string): Promise<YtCookies | null> {
  const [row] = await db
    .select({ teamId: teamYoutubeCookies.teamId, cookies: teamYoutubeCookies.cookies })
    .from(shows)
    .innerJoin(teamYoutubeCookies, eq(teamYoutubeCookies.teamId, shows.teamId))
    .where(eq(shows.id, showId));
  if (!row) return null;
  const { teamId, cookies: text } = row;
  return {
    text,
    async report({ ok, refreshed, authError }) {
      const rotated = refreshed ? rotatedCookies(refreshed) : null;
      const signedOut = rotated === 'signedOut';
      const next = rotated && rotated !== 'signedOut' ? rotated : null;
      try {
        // Only over the cookies this run started with: newer ones (set by a user or rotated by a
        // concurrent run) win. A signed-out copy is not stored; the error says what to do.
        if (next)
          await db
            .update(teamYoutubeCookies)
            .set({ cookies: next.text, expiresAt: next.expiresAt })
            .where(
              and(eq(teamYoutubeCookies.teamId, teamId), eq(teamYoutubeCookies.cookies, text)),
            );
        // The outcome belongs to the cookies this run used (or rotated them into), not to cookies
        // someone set while it ran.
        await db
          .update(teamYoutubeCookies)
          .set(
            ok && !signedOut
              ? { lastOkAt: new Date(), lastError: null }
              : {
                  lastFailedAt: new Date(),
                  lastError: signedOut
                    ? SIGNED_OUT_MESSAGE
                    : (authError?.message.slice(0, 1000) ?? null),
                },
          )
          .where(
            and(
              eq(teamYoutubeCookies.teamId, teamId),
              inArray(teamYoutubeCookies.cookies, next ? [text, next.text] : [text]),
            ),
          );
      } catch (e) {
        throw new Error(`recording the YouTube sign-in outcome: ${dbErrorText(e)}`);
      }
    },
  };
}
