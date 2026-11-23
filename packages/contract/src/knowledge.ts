// Knowledge extraction from wiki page bodies, shared by the server (moments, graph export) and
// tests. A page is read as blocks (paragraphs, list items, table rows) under a heading path; each
// block's citations become "moments" (clip-ready session ranges) described by the block's text and
// tagged with the pages it links.

import {
  type WikiCitation,
  wikiCitationSpans,
  wikiCitations,
  wikiLinkTargets,
} from './wikiLinks.ts';

/** One citation of a block with the words that make its claim. */
export interface BlockCitation {
  citation: WikiCitation;
  /** The sentence the citation closes (from its start up to the citation), citations removed. */
  text: string;
  /** [[link]] targets in that sentence. */
  links: string[];
}

export interface WikiBlock {
  /** 1-based position among the page's blocks. */
  ord: number;
  /** Headings above the block, outermost first (without the `#` marks). */
  headings: string[];
  /** The block as written. */
  markdown: string;
  /** Readable text: links and citations replaced by their labels, emphasis and code marks removed. */
  text: string;
  /** Session citations in the block, in order. */
  citations: WikiCitation[];
  /** Distinct [[link]] targets in the block, as written. */
  links: string[];
  /** Each citation with its own sentence and links (same order as `citations`). */
  claims: BlockCitation[];
}

export interface WikiSection {
  /** 1-based position among the page's sections (0 is never used; the intro is 1 when present). */
  ord: number;
  /** Headings of the section, outermost first; empty for the text before the first heading. */
  headings: string[];
  markdown: string;
  text: string;
  citations: WikiCitation[];
  links: string[];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;
const TABLE_ROW = /^\s*\|/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * Markdown → readable text: citations and links become their labels (a bare citation `[@…]`
 * disappears; `citations: false` drops citations entirely), [[Title|label]] becomes label, emphasis/code/heading/list/quote marks go, table
 * pipes become " · ", whitespace collapses.
 */
export function plainText(markdown: string, opts: { citations?: boolean } = {}): string {
  return (opts.citations === false ? withoutCitations(markdown) : markdown)
    .replace(/\[\[([^[\]|\n]+?)(?:\\?\|([^[\]\n]+?))?\]\]/g, (_, t: string, l?: string) =>
      (l ?? t).trim(),
    )
    .replace(/(?<!\])\[@[^\s[\]\\]+\](?![([])/g, '')
    .replace(/!?\[((?:\\.|[^\\[\]\n])*)\]\([^)\n]*\)/g, (_, l: string) => l.replace(/\\(.)/g, '$1'))
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])([*_])(?!\s)(.+?)(?<!\s)\1(?![\w*])/g, '$2')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\\\|/g, '|')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/^ · | · $/g, '')
    .replace(/\s+/g, ' ')
    .replace(/([([]) /g, '$1')
    .replace(/ ([)\],.;:!?])/g, '$1')
    .replace(/\(\)|\[\]/g, '')
    .trim();
}

/** Markdown with every citation cut out (short forms too, whatever their session). */
function withoutCitations(markdown: string): string {
  let out = '';
  let last = 0;
  for (const c of wikiCitationSpans(markdown, '_')) {
    out += markdown.slice(last, c.start);
    last = c.end;
  }
  return out + markdown.slice(last);
}

/** Where sentences start in a block: offset 0 and after `. `, `! `, `? ` (closing marks allowed). */
function sentenceStarts(markdown: string): number[] {
  const starts = [0];
  for (const m of markdown.matchAll(/[.!?;]["'\u201d\u2019)\]*_]*\s+/g))
    starts.push(m.index! + m[0].length);
  // A table cell also starts a claim; pipes inside [[Title|label]] links don't count.
  const outsideLinks = markdown.replace(/\[\[[^\]\n]*\]\]/g, (l) => 'x'.repeat(l.length));
  for (const m of outsideLinks.matchAll(/(?<!\\)\|/g)) starts.push(m.index! + 1);
  return [...new Set(starts)].sort((a, b) => a - b);
}

/**
 * Each citation of a block with the sentence it closes: from the start of its sentence up to the
 * citation, citations removed. A citation that opens its sentence (e.g. right after the full stop)
 * takes the previous sentence.
 */
function blockClaims(markdown: string, pageSessionId: string | null | undefined): BlockCitation[] {
  const spans = wikiCitationSpans(markdown, pageSessionId);
  const starts = sentenceStarts(markdown);
  return spans.map(({ start, end, ...citation }) => {
    const before = starts.filter((b) => b <= start);
    let piece = '';
    for (let i = before.length - 1; i >= 0; i--) {
      piece = markdown.slice(before[i], end);
      if (plainText(withoutCitations(piece)).replace(/[\s.,;:!?—–-]+/g, '')) break;
    }
    return {
      citation,
      text: plainText(piece, { citations: false }).replace(/[\s.,;:]+$/, ''),
      links: wikiLinkTargets(piece),
    };
  });
}

function finish<T extends { markdown: string }>(
  item: T,
  pageSessionId: string | null | undefined,
): T & { text: string; citations: WikiCitation[]; links: string[] } {
  return {
    ...item,
    text: plainText(item.markdown),
    citations: wikiCitations(item.markdown, pageSessionId),
    links: wikiLinkTargets(item.markdown),
  };
}

/**
 * The blocks of a page body: each paragraph, list item (with its indented continuation lines) and
 * table row (not the header rule) is one block, with the headings it sits under. Fenced code is
 * skipped. Short citations resolve to `pageSessionId` (the page's own session), as in wikiCitations.
 */
export function wikiBlocks(bodyMd: string, pageSessionId?: string | null): WikiBlock[] {
  const blocks: WikiBlock[] = [];
  const headings: { level: number; text: string }[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const markdown = current.join('\n').trim();
    current = [];
    if (!markdown) return;
    blocks.push({
      ...finish(
        { ord: blocks.length + 1, headings: headings.map((h) => h.text), markdown },
        pageSessionId,
      ),
      claims: blockClaims(markdown, pageSessionId),
    });
  };
  for (const line of bodyMd.split(/\r?\n/)) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      flush();
      fence = f[1]!;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      const level = h[1]!.length;
      while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
      headings.push({ level, text: plainText(h[2] ?? '') });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (TABLE_ROW.test(line)) {
      flush();
      if (!TABLE_RULE.test(line)) {
        current = [line];
        flush();
      }
      continue;
    }
    if (LIST_ITEM.test(line)) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * The sections of a page body, split at every heading (any level); text before the first heading is
 * its own section. Meant as retrieval chunks: each carries its heading path, so a chunk can be
 * prefixed with "<page> › <headings>" and still say what it is about.
 */
export function wikiSections(bodyMd: string, pageSessionId?: string | null): WikiSection[] {
  const sections: WikiSection[] = [];
  const headings: { level: number; text: string }[] = [];
  let current: string[] = [];
  let currentHeadings: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const markdown = current.join('\n').trim();
    current = [];
    if (!markdown) return;
    sections.push(
      finish({ ord: sections.length + 1, headings: currentHeadings, markdown }, pageSessionId),
    );
  };
  for (const line of bodyMd.split(/\r?\n/)) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      current.push(line);
      continue;
    }
    if (f) fence = f[1]!;
    const h = f ? null : HEADING.exec(line);
    if (h) {
      flush();
      const level = h[1]!.length;
      while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
      headings.push({ level, text: plainText(h[2] ?? '') });
      currentHeadings = headings.map((x) => x.text);
      continue;
    }
    current.push(line);
  }
  flush();
  return sections;
}
