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

/** A citation: a Markdown link to a range of a session, `[label](/sessions/<id>?t=<sec>&to=<sec>)`. */
export interface WikiCitation {
  sessionId: string;
  /** Seconds from the session start (transcript_text's @seconds). */
  startSec: number;
  /** End of the range in seconds when the link has `to`, as written (wiki.lint flags to <= t). */
  endSec?: number;
  label: string;
}

/** `[label](/sessions/<id>?<query>)`, optionally with a quoted link title after the URL. */
const CITATION_LINK =
  /\[((?:\\.|[^\\[\]\n])*)\]\(\s*\/sessions\/([A-Za-z0-9_-]+)\/?\?([^\s)]*)(?:\s+"[^"\n]*")?\s*\)/g;

const SECONDS = /^\d+(?:\.\d+)?$/;

/** The query parameters of a citation link (`t`, `to`), or null when it is not one. */
export function citationRange(query: string): { startSec: number; endSec?: number } | null {
  const params = new URLSearchParams(query);
  const t = params.get('t') ?? '';
  if (!SECONDS.test(t)) return null;
  const to = params.get('to') ?? '';
  return { startSec: Number(t), ...(SECONDS.test(to) ? { endSec: Number(to) } : {}) };
}

/**
 * The session citations of a page body, in order (repeats kept): in-app Markdown links to
 * `/sessions/<id>` with a numeric `t` (seconds from the session start, required) and an optional
 * `to`. Links inside code are ignored, as for [[links]]. A session link without `t` is not a
 * citation.
 */
export function wikiCitations(bodyMd: string): WikiCitation[] {
  const out: WikiCitation[] = [];
  for (const m of linkableText(bodyMd).matchAll(CITATION_LINK)) {
    const range = citationRange(m[3] ?? '');
    if (!range) continue;
    const label = (m[1] ?? '').replace(/\\(.)/g, '$1').trim();
    out.push({ sessionId: m[2]!, ...range, label });
  }
  return out;
}

/**
 * The body with the `to` of some citations rewritten, everything else kept byte for byte:
 * `endFor(citation)` returns the new end in seconds, or undefined to keep the link as written.
 * Only citations with a `to` are offered; links inside code are left alone, as in wikiCitations.
 */
export function setCitationEnds(
  bodyMd: string,
  endFor: (c: WikiCitation) => number | undefined,
): string {
  // Code blanked to spaces (newlines kept), so match offsets are offsets in bodyMd.
  const blank = (code: string) => code.replace(/[^\n]/g, ' ');
  const masked = bodyMd.replace(FENCED_CODE, blank).replace(CODE_SPAN, blank);
  let out = '';
  let last = 0;
  for (const m of masked.matchAll(new RegExp(CITATION_LINK.source, 'gd'))) {
    const query = m[3] ?? '';
    const range = citationRange(query);
    if (range?.endSec == null) continue;
    const label = (m[1] ?? '').replace(/\\(.)/g, '$1').trim();
    const to = endFor({ sessionId: m[2]!, ...range, label });
    if (to === undefined) continue;
    const [from, until] = m.indices![3]!;
    out += bodyMd.slice(last, from) + query.replace(/(^|&)to=[^&#]*/, `$1to=${to}`);
    last = until;
  }
  return out + bodyMd.slice(last);
}
