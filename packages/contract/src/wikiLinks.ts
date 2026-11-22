// Wiki link syntax, shared by the server (lint, link checks) and the web renderer.
// [[Title]] and [[Title|label]]; inside a GFM table cell the pipe is escaped: [[Title\|label]].

/** One [[Title]] / [[Title|label]] link in Markdown text (global: reset lastIndex before exec). */
export const WIKI_LINK = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g;

/** Title normalisation used to match link targets to page titles and aliases. */
export const normTitle = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');

const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm;
const CODE_SPAN = /(`+)[^`][\s\S]*?\1/g;

/**
 * The Markdown text a reader sees links in: fenced code blocks and inline code spans removed
 * (the renderer does not link inside code), and `\|` unescaped as GFM does in table cells.
 */
function linkableText(bodyMd: string): string {
  return bodyMd.replace(FENCED_CODE, '').replace(CODE_SPAN, '').replace(/\\\|/g, '|');
}

/** Distinct link targets of a page body, trimmed as written, in order of first appearance. */
export function wikiLinkTargets(bodyMd: string): string[] {
  const seen = new Map<string, string>();
  for (const m of linkableText(bodyMd).matchAll(WIKI_LINK)) {
    const t = (m[1] ?? '').trim();
    if (t && !seen.has(normTitle(t))) seen.set(normTitle(t), t);
  }
  return [...seen.values()];
}

/**
 * A citation: a Markdown link to a range of a session, `[label](/sessions/<id>?t=<sec>&to=<sec>)`,
 * or one of its short forms (see wikiCitations).
 */
export interface WikiCitation {
  sessionId: string;
  /** Seconds from the session start (transcript_text's @seconds). */
  startSec: number;
  /** End of the range in seconds when the link has `to`, as written (wiki.lint flags to <= t). */
  endSec?: number;
  label: string;
}

/**
 * Every citation form, in one pass so body order is kept:
 * `[label](/sessions/<id>?<query>)` (groups 1–3), the short link `[label](@<ref>)` (groups 1, 4)
 * and the bare `[@<ref>]` (group 5) — links optionally with a quoted title after the target. A bare
 * form right after `]` or directly followed by `(` or `[` is part of a link, not a citation.
 */
const CITATION_LINK =
  /\[((?:\\.|[^\\[\]\n])*)\]\(\s*(?:\/sessions\/([A-Za-z0-9_-]+)\/?\?([^\s)]*)|@([^\s)"]+))(?:\s+"[^"\n]*")?\s*\)|(?<!\])\[@([^\s[\]\\]+)\](?![([])/g;

/** The bare short form `[@<ref>]` in rendered text (the web's remark plugin; global). */
export const BARE_CITATION = /(?<!\])\[@([^\s[\]\\]+)\](?![([])/g;

/** `<startSec>[-<endSec>]`, optionally prefixed with `<sessionId>:`; an en dash works too. */
const SHORT_REF = /^(?:([A-Za-z0-9_-]+):)?(\d+(?:\.\d+)?)(?:[-\u2013](\d+(?:\.\d+)?))?$/;

/**
 * The target of a short citation, `@1664-1760` / `@ses_abc:1664-1760` without the `@`: its session
 * (the page's own `pageSessionId` when the ref names none; null when there is none either), start
 * and optional end in seconds. Null when `ref` is not a short citation.
 */
export function shortCitationRef(
  ref: string,
  pageSessionId?: string | null,
): { sessionId: string | null; startSec: number; endSec?: number } | null {
  const m = SHORT_REF.exec(ref);
  if (!m) return null;
  return {
    sessionId: m[1] ?? pageSessionId ?? null,
    startSec: Number(m[2]),
    ...(m[3] ? { endSec: Number(m[3]) } : {}),
  };
}

/** The long href a citation resolves to, `/sessions/<id>?t=<startSec>[&to=<endSec>]`. */
export const citationHref = (c: { sessionId: string; startSec: number; endSec?: number }) =>
  `/sessions/${encodeURIComponent(c.sessionId)}?t=${c.startSec}${c.endSec !== undefined ? `&to=${c.endSec}` : ''}`;

const SECONDS = /^\d+(?:\.\d+)?$/;

/** The query parameters of a citation link (`t`, `to`), or null when it is not one. */
export function citationRange(query: string): { startSec: number; endSec?: number } | null {
  const params = new URLSearchParams(query);
  const t = params.get('t') ?? '';
  if (!SECONDS.test(t)) return null;
  const to = params.get('to') ?? '';
  return { startSec: Number(t), ...(SECONDS.test(to) ? { endSec: Number(to) } : {}) };
}

/** One citation match: resolved (sessionId null when a short form names no session and the page has none). */
function citationOf(
  m: RegExpMatchArray,
  pageSessionId?: string | null,
): (Omit<WikiCitation, 'sessionId'> & { sessionId: string | null; written: string }) | null {
  const label = (m[1] ?? '').replace(/\\(.)/g, '$1').trim();
  if (m[2]) {
    const range = citationRange(m[3] ?? '');
    return range && { sessionId: m[2], ...range, label, written: m[0] };
  }
  const short = shortCitationRef(m[4] ?? m[5] ?? '', pageSessionId);
  return short && { ...short, label, written: m[0] };
}

/**
 * The session citations of a page body, in order (repeats kept): in-app Markdown links to
 * `/sessions/<id>` with a numeric `t` (seconds from the session start, required) and an optional
 * `to`, and the short forms `[label](@<startSec>-<endSec>)` / `[@<startSec>-<endSec>]` (resolved to
 * `pageSessionId`, the page's own session) and `[label](@<sessionId>:<startSec>-<endSec>)` /
 * `[@<sessionId>:<startSec>-<endSec>]` (any page). A bare form has an empty label. Links inside code
 * are ignored, as for [[links]]. A session link without `t`, and a short form without a session to
 * resolve to, is not a citation.
 */
export function wikiCitations(bodyMd: string, pageSessionId?: string | null): WikiCitation[] {
  const out: WikiCitation[] = [];
  for (const m of linkableText(bodyMd).matchAll(CITATION_LINK)) {
    const c = citationOf(m, pageSessionId);
    if (c?.sessionId)
      out.push({
        sessionId: c.sessionId,
        startSec: c.startSec,
        ...(c.endSec !== undefined ? { endSec: c.endSec } : {}),
        label: c.label,
      });
  }
  return out;
}

/**
 * Short citations written without a session (`[label](@1664-1760)`, `[@1664-1760]`) on a page that
 * has none to resolve them to, as written. Saves reject them.
 */
export function unresolvedShortCitations(bodyMd: string, pageSessionId?: string | null): string[] {
  if (pageSessionId) return [];
  const out: string[] = [];
  for (const m of linkableText(bodyMd).matchAll(CITATION_LINK)) {
    const c = citationOf(m);
    if (c && !c.sessionId) out.push(c.written);
  }
  return out;
}

/**
 * The body with the `to` of some citations rewritten, everything else kept byte for byte:
 * `endFor(citation)` returns the new end in seconds, or undefined to keep the citation as written.
 * Only citations with an end are offered — long links (`to=`) and short forms (`@<start>-<end>`,
 * resolved against `pageSessionId`); links inside code are left alone, as in wikiCitations.
 */
export function setCitationEnds(
  bodyMd: string,
  endFor: (c: WikiCitation) => number | undefined,
  pageSessionId?: string | null,
): string {
  // Code blanked to spaces (newlines kept), so match offsets are offsets in bodyMd.
  const blank = (code: string) => code.replace(/[^\n]/g, ' ');
  const masked = bodyMd.replace(FENCED_CODE, blank).replace(CODE_SPAN, blank);
  let out = '';
  let last = 0;
  for (const m of masked.matchAll(new RegExp(CITATION_LINK.source, 'gd'))) {
    const c = citationOf(m, pageSessionId);
    if (!c?.sessionId || c.endSec == null) continue;
    const to = endFor({
      sessionId: c.sessionId,
      startSec: c.startSec,
      endSec: c.endSec,
      label: c.label,
    });
    if (to === undefined) continue;
    // The written part to rewrite: the long link's query, or the short form's ref.
    const g = m[2] ? 3 : m[4] !== undefined ? 4 : 5;
    const [from, until] = m.indices![g]!;
    const part = bodyMd.slice(from, until);
    const next =
      g === 3
        ? part.replace(/(^|&)to=[^&#]*/, `$1to=${to}`)
        : part.replace(/([-\u2013])\d+(?:\.\d+)?$/, `$1${to}`);
    out += bodyMd.slice(last, from) + next;
    last = until;
  }
  return out + bodyMd.slice(last);
}
