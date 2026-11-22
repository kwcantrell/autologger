// Wiki link syntax, shared by the server (lint, link checks) and the web renderer.
// [[Title]] and [[Title|label]]; inside a GFM table cell the pipe is escaped: [[Title\|label]].

/** One [[Title]] / [[Title|label]] link in Markdown text (global: reset lastIndex before exec). */
export const WIKI_LINK = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g;

/** Title normalisation used to match link targets to page titles and aliases. */
export const normTitle = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The Markdown text a reader sees links in: fenced code blocks and inline code spans removed
 * (the renderer does not link inside code), and `\|` unescaped as GFM does in table cells.
 */
function linkableText(bodyMd: string): string {
  return bodyMd
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, '')
    .replace(/(`+)[^`][\s\S]*?\1/g, '')
    .replace(/\\\|/g, '|');
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
