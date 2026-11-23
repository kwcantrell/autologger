// The documentation's index, built from the front matter of the Markdown files in the repo's docs/
// folder. Pure and dependency-free: the Vite plugin in vite.config.ts runs it at build time to
// emit `virtual:docs` (page metadata plus one lazy loader per page), and the docs route uses the
// same helpers for headings, slugs and previous/next. There is no separate nav file: a page is
// published when it starts with front matter, and the sidebar follows section, order, title.

export const DOC_SECTIONS = [
  { id: 'guide', label: 'Using AutoLogger' },
  { id: 'agents', label: 'Agents & MCP' },
  { id: 'developers', label: 'Developers' },
] as const;

export type DocSectionId = (typeof DOC_SECTIONS)[number]['id'];

export interface DocMeta {
  /** URL path under /docs: '' for the home page (docs/index.md), else '<section>/<slug>'. */
  path: string;
  /** Source file relative to the repo root, e.g. 'docs/guide/topics.md'. */
  file: string;
  title: string;
  description: string;
  /** null for the home page. */
  section: DocSectionId | null;
  order: number;
}

const DEFAULT_ORDER = 1000;

/**
 * Splits `---`-fenced front matter off a Markdown file. Returns null when the file has none (it
 * is then not published). Values are single-line `key: value` pairs; matching single or double
 * quotes around a value are dropped; blank lines and `#` comments are ignored. Anything else
 * throws, so a typo fails the build instead of silently dropping a page.
 */
export function parseFrontMatter(
  source: string,
): { data: Record<string, string>; body: string } | null {
  const text = source.replace(/^﻿/, '');
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return null;
  const rest = text.slice(open[0].length);
  const close = /^---[ \t]*$/m.exec(rest);
  if (!close) throw new Error('front matter is not closed with a --- line');
  const data: Record<string, string> = {};
  for (const raw of rest.slice(0, close.index).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) throw new Error(`front matter line is not "key: value": ${line}`);
    let value = m[2].trim();
    if (value.length >= 2 && /^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    data[m[1]] = value;
  }
  const body = rest.slice(close.index + close[0].length).replace(/^\s*\r?\n/, '');
  return { data, body };
}

/**
 * The page a docs file publishes, or null when it has no front matter. `file` is relative to the
 * docs folder ('index.md', 'guide/topics.md'). Throws (with the file name) on a page that would
 * be published wrongly: missing title or description, an unknown section folder, a section that
 * does not match the folder, a slug that is not lowercase-with-dashes, or a non-numeric order.
 */
export function docMetaFromFile(file: string, source: string): DocMeta | null {
  const fail = (why: string): never => {
    throw new Error(`docs/${file}: ${why}`);
  };
  let fm: ReturnType<typeof parseFrontMatter>;
  try {
    fm = parseFrontMatter(source);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!fm) return null;
  const { data } = fm;
  if (!data.title) fail('front matter needs a title');
  if (!data.description) fail('front matter needs a description');
  const order = data.order === undefined || data.order === '' ? DEFAULT_ORDER : Number(data.order);
  if (!Number.isFinite(order)) fail(`order must be a number, got "${data.order}"`);
  const base = { file: `docs/${file}`, title: data.title, description: data.description, order };
  if (file === 'index.md') {
    if (data.section) fail('the home page has no section');
    return { ...base, path: '', section: null };
  }
  const m = /^([^/]+)\/([^/]+)\.md$/.exec(file);
  if (!m) return fail('pages live at docs/<section>/<slug>.md');
  const [, folder, slug] = m;
  const section = DOC_SECTIONS.find((s) => s.id === folder)?.id;
  if (!section) fail(`unknown section folder "${folder}" (${DOC_SECTIONS.map((s) => s.id)})`);
  if (data.section !== folder) fail(`section must be "${folder}" to match its folder`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) fail(`slug "${slug}" must be lowercase-with-dashes`);
  return { ...base, path: `${folder}/${slug}`, section: section as DocSectionId };
}

const sectionRank = (s: DocSectionId | null) =>
  s === null ? -1 : DOC_SECTIONS.findIndex((x) => x.id === s);

/** Reading order: the home page, then each section in DOC_SECTIONS order, by order, then title. */
export function sortDocs(pages: readonly DocMeta[]): DocMeta[] {
  return [...pages].sort(
    (a, b) =>
      sectionRank(a.section) - sectionRank(b.section) ||
      a.order - b.order ||
      a.title.localeCompare(b.title) ||
      a.path.localeCompare(b.path),
  );
}

/** Sections that have at least one page, each with its pages in reading order. */
export function docSections(sorted: readonly DocMeta[]) {
  return DOC_SECTIONS.map((s) => ({
    ...s,
    pages: sorted.filter((p) => p.section === s.id),
  })).filter((s) => s.pages.length > 0);
}

/** The pages before and after `path` in reading order (null at either end). */
export function docNeighbours(sorted: readonly DocMeta[], path: string) {
  const i = sorted.findIndex((p) => p.path === path);
  if (i < 0) return { prev: null, next: null };
  return { prev: sorted[i - 1] ?? null, next: sorted[i + 1] ?? null };
}

// ── headings ───────────────────────────────────────────────────────────────

/**
 * A heading's anchor: lowercase, punctuation other than hyphens dropped, each run of spaces one
 * hyphen ("Import from your own computer" → import-from-your-own-computer, "autologger-ask" →
 * autologger-ask, "Tokens & OAuth" → tokens-oauth).
 */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Slugs for headings in document order; repeats get -1, -2… so every anchor is unique. */
export function createSlugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = headingSlug(text) || 'section';
    const n = seen.get(base);
    seen.set(base, (n ?? -1) + 1);
    return n === undefined ? base : `${base}-${n + 1}`;
  };
}

/**
 * A heading line's visible text: link targets, code ticks and emphasis markers removed (an
 * underscore only around words, so snake_case survives). Its slug equals the rendered heading's.
 */
export function headingText(raw: string): string {
  return raw
    .replace(/\s+#+\s*$/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|~~|\*)(.+?)\1/g, '$2')
    .replace(/(^|[^\p{L}\p{N}])(__|_)(.+?)\2(?=[^\p{L}\p{N}]|$)/gu, '$1$3')
    .trim();
}

export interface DocHeading {
  depth: number;
  text: string;
  id: string;
}

/**
 * The ATX headings of a Markdown body (outside fenced code), with the ids the renderer gives them:
 * both slug every heading in order with one slugger, so repeated titles get the same suffixes.
 */
export function extractHeadings(body: string): DocHeading[] {
  const slug = createSlugger();
  const out: DocHeading[] = [];
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (!h) continue;
    const text = headingText(h[2]);
    out.push({ depth: h[1].length, text, id: slug(text) });
  }
  return out;
}
