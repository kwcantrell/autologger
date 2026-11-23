// A team's YouTube sign-in for the server's yt-dlp: a cookies.txt stored per team
// (team_youtube_cookies), used by every yt-dlp run for the team's shows and refreshed from
// yt-dlp's rotated copy after each run. yt-dlp has no working YouTube account login (YouTube blocks
// username/password and OAuth sign-ins), so cookies from a signed-in browser are the only way.

import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import type { YtCookies } from './youtube.ts';

const { teamYoutubeCookies, shows } = schema;

/** Domains whose cookies yt-dlp needs for YouTube; every other line is dropped before storing. */
const KEEP_DOMAIN = /(^|\.)(youtube\.com|google\.com)$/i;
/** Cookies that only exist while an account is signed in. */
const SIGNED_IN = new Set(['SID', '__Secure-1PSID', '__Secure-3PSID', 'SAPISID', 'LOGIN_INFO']);
/** The ones whose expiry is the session's: the earliest is reported as expiresAt. */
const SESSION = new Set(['SID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO']);

interface Cookie {
  domain: string;
  includeSubdomains: boolean;
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
    if (f.length < 7) continue;
    out.push({
      domain: f[0]!.trim(),
      includeSubdomains: f[1]!.toUpperCase() === 'TRUE',
      path: f[2] || '/',
      secure: f[3]!.toUpperCase() === 'TRUE',
      expires: Math.max(0, Math.floor(Number(f[4])) || 0),
      name: f[5]!,
      value: f.slice(6).join('\t'),
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
    if (!c || typeof c.name !== 'string' || typeof c.domain !== 'string') return [];
    const exp = Number(c.expirationDate ?? c.expires ?? 0);
    return [
      {
        domain: c.domain,
        includeSubdomains: c.hostOnly === undefined ? c.domain.startsWith('.') : !c.hostOnly,
        path: typeof c.path === 'string' ? c.path : '/',
        secure: Boolean(c.secure),
        expires: Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : 0,
        name: c.name,
        value: String(c.value ?? ''),
        httpOnly: Boolean(c.httpOnly),
      },
    ];
  });
}

/**
 * Check and slim down a pasted or uploaded cookie export: Netscape cookies.txt or a JSON array.
 * Keeps the youtube.com / google.com cookies only and requires a signed-in session among them.
 * Throws an Error with a user-facing message.
 */
export function parseYoutubeCookies(input: string): ParsedCookies {
  const trimmed = input.trim();
  const all = trimmed.startsWith('[') ? fromJson(trimmed) : fromNetscape(trimmed);
  if (!all || all.length === 0)
    throw new Error(
      'That is not a cookie export. Paste a Netscape cookies.txt (e.g. from the "Get cookies.txt LOCALLY" browser extension, or `yt-dlp --cookies-from-browser`) or a JSON cookie export.',
    );
  const now = Date.now() / 1000;
  const kept = all.filter(
    (c) =>
      KEEP_DOMAIN.test(c.domain.replace(/^\./, '')) &&
      /^[\x21-\x7e]+$/.test(c.name) &&
      !/[\t\r\n]/.test(c.value) &&
      (c.expires === 0 || c.expires > now),
  );
  if (!kept.some((c) => SIGNED_IN.has(c.name)))
    throw new Error(
      kept.length
        ? 'These cookies are not from a signed-in YouTube session (no SID or LOGIN_INFO cookie). Sign in to YouTube in the browser first, then export the cookies of youtube.com again.'
        : 'No youtube.com cookies found. Export the cookies while on youtube.com, signed in.',
    );
  const expiries = kept.filter((c) => SESSION.has(c.name) && c.expires > 0).map((c) => c.expires);
  const lines = kept.map((c) =>
    [
      `${c.httpOnly ? '#HttpOnly_' : ''}${c.domain}`,
      c.includeSubdomains ? 'TRUE' : 'FALSE',
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
      let next: ParsedCookies | null = null;
      if (refreshed) {
        try {
          next = parseYoutubeCookies(refreshed);
        } catch {
          next = null; // signed out by YouTube: keep the old ones, the error says what to do
        }
      }
      await db
        .update(teamYoutubeCookies)
        .set(
          ok
            ? { lastOkAt: new Date(), lastError: null }
            : { lastFailedAt: new Date(), lastError: authError?.message.slice(0, 1000) ?? null },
        )
        .where(eq(teamYoutubeCookies.teamId, teamId));
      // Only over the cookies this run started with: newer ones (set by a user or rotated by a
      // concurrent run) win.
      if (next)
        await db
          .update(teamYoutubeCookies)
          .set({ cookies: next.text, expiresAt: next.expiresAt })
          .where(and(eq(teamYoutubeCookies.teamId, teamId), eq(teamYoutubeCookies.cookies, text)));
    },
  };
}
