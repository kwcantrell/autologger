// A wiki page body rendered as GitHub-flavoured Markdown (tables, strikethrough, task lists) into
// React elements. Raw HTML is skipped, never parsed.
// Only http(s) links, in-app paths (/wiki/…, /sessions/…) and [[Title]] / [[Title|label]] wiki
// links stay clickable: `urlTransform` blanks every other URL and the `a` renderer shows a blank
// link as its text. Images render as their alt text. [[…]] links resolve against the show's page
// titles and aliases; an unknown title renders dim with a "No page named …" tooltip. Inside a table
// cell an aliased link escapes its pipe, as GFM requires: [[Title\|label]].

import type { ReactNode } from 'react';
import Markdown, { type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'wouter';
import { cn } from '@/shared/lib/utils';
import { markdownTableComponents } from '@/shared/ui/markdownTable';
import { Tooltip } from '@/shared/ui/Tooltip';
import { type WikiResolver, wikiHref } from './wikiShared';

const WIKI_SCHEME = 'wikititle:';
const IN_APP = /^\/(wiki|sessions)\//;

const urlTransform: UrlTransform = (url) =>
  url.startsWith(WIKI_SCHEME) || /^https?:\/\//i.test(url) || IN_APP.test(url) ? url : '';

// ── remark plugin: [[Title]] / [[Title|label]] inside text nodes become links ──────────────────

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

const WIKI_LINK = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g;

function splitText(value: string): MdNode[] | null {
  WIKI_LINK.lastIndex = 0;
  if (!WIKI_LINK.test(value)) return null;
  WIKI_LINK.lastIndex = 0;
  const out: MdNode[] = [];
  let last = 0;
  for (let m = WIKI_LINK.exec(value); m; m = WIKI_LINK.exec(value)) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
    const title = (m[1] ?? '').trim();
    const label = (m[2] ?? '').trim() || title;
    out.push({
      type: 'link',
      url: WIKI_SCHEME + encodeURIComponent(title),
      children: [{ type: 'text', value: label }],
    });
    last = m.index + m[0].length;
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function walk(node: MdNode) {
  if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && child.value) {
      const parts = splitText(child.value);
      if (parts) {
        next.push(...parts);
        continue;
      }
    }
    walk(child);
    next.push(child);
  }
  node.children = next;
}

function remarkWikiLinks() {
  return (tree: MdNode) => walk(tree);
}

// ── renderers ─────────────────────────────────────────────────────────────────────────────────

const LINK_CLASS =
  'text-si-fg underline decoration-(--si-line-strong) underline-offset-2 hover-always:text-si-accent';

function components(resolve: WikiResolver): Components {
  return {
    a({ href, children }) {
      if (!href) return <span>{children}</span>;
      if (href.startsWith(WIKI_SCHEME)) {
        const title = decodeURIComponent(href.slice(WIKI_SCHEME.length));
        const page = resolve(title);
        if (page)
          return (
            <Link href={wikiHref(page.id)} className={LINK_CLASS}>
              {children}
            </Link>
          );
        return <UnresolvedLink title={title}>{children}</UnresolvedLink>;
      }
      if (IN_APP.test(href))
        return (
          <Link href={href} className={LINK_CLASS}>
            {children}
          </Link>
        );
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          {children}
        </a>
      );
    },
    img({ alt }) {
      return <>{alt ?? ''}</>;
    },
    ...markdownTableComponents,
  };
}

function UnresolvedLink({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Tooltip content={`No page named “${title}”`}>
      <span
        data-slot="wiki-link-missing"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users get the "no page" tooltip
        tabIndex={0}
        className="cursor-help text-si-dim underline decoration-dotted decoration-(--si-line-strong) underline-offset-2"
      >
        {children}
      </span>
    </Tooltip>
  );
}

const PROSE_CLASS = [
  'text-[0.9rem] leading-relaxed text-si-fg break-words',
  '[&_p]:my-2 [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold',
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold',
  '[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-base [&_h3]:font-semibold',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-(--si-line-strong) [&_blockquote]:pl-3 [&_blockquote]:text-si-muted',
  '[&_code]:font-mono [&_code]:text-[0.85em] [&_pre]:overflow-x-auto [&_pre]:rounded-ctl [&_pre]:bg-si-panel-2 [&_pre]:p-3',
  '[&_hr]:my-4 [&_hr]:border-si-line [&_del]:text-si-muted',
  '[&_.contains-task-list]:list-none [&_.contains-task-list]:pl-1 [&_.task-list-item_input]:mr-1.5',
].join(' ');

export function WikiMarkdown({
  body,
  resolve,
  className,
}: {
  body: string;
  resolve: WikiResolver;
  className?: string;
}) {
  return (
    <div data-slot="wiki-markdown" className={cn(PROSE_CLASS, className)}>
      <Markdown
        skipHtml
        urlTransform={urlTransform}
        // biome-ignore lint/suspicious/noExplicitAny: a minimal local mdast shape instead of a types dep
        remarkPlugins={[remarkGfm, remarkWikiLinks as any]}
        components={components(resolve)}
      >
        {body}
      </Markdown>
    </div>
  );
}
