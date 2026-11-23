// A docs page body: GitHub-flavoured Markdown (tables, fenced code) without raw HTML, wiki links or
// citations. Headings get anchor ids (the same slugs extractHeadings gives "On this page"), code
// blocks get a Copy button, app paths (/docs/…, /settings) navigate in place, `#…` jumps within
// the page and other http(s) links open in a new tab. Images render as their alt text.

import { CheckIcon, CopyIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import Markdown, { type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'wouter';
import { showToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { markdownTableComponents } from '@/shared/ui/markdownTable';
import { Tooltip } from '@/shared/ui/Tooltip';
import { createSlugger } from './docsIndex';

const urlTransform: UrlTransform = (url) =>
  /^https?:\/\//i.test(url) || url.startsWith('/') || url.startsWith('#') ? url : '';

// ── remark plugin: ids for top-level headings, in document order ─────────────────────────────

interface MdNode {
  type: string;
  value?: string;
  alt?: string;
  depth?: number;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

function mdText(node: MdNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  if (node.type === 'image') return node.alt ?? '';
  return (node.children ?? []).map(mdText).join('');
}

function remarkHeadingIds() {
  return (tree: MdNode) => {
    const slug = createSlugger();
    for (const node of tree.children ?? []) {
      if (node.type !== 'heading') continue;
      node.data = {
        ...node.data,
        hProperties: { ...node.data?.hProperties, id: slug(mdText(node)) },
      };
    }
  };
}

// ── components ──────────────────────────────────────────────────────────────────────────────────

interface HastNode {
  type: string;
  value?: string;
  children?: HastNode[];
}

function hastText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

function CopyCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast('Copy failed. Select the code and copy it instead.', true);
    }
  }
  return (
    <Tooltip content={copied ? 'Copied' : 'Copy code'}>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => void copy()}
        aria-label={copied ? 'Copied' : 'Copy code'}
        className="absolute top-1.5 right-1.5 size-8 border-si-line bg-si-panel text-si-muted"
      >
        {copied ? (
          <CheckIcon aria-hidden="true" className="size-4" />
        ) : (
          <CopyIcon aria-hidden="true" className="size-4" />
        )}
      </Button>
    </Tooltip>
  );
}

const LINK =
  'text-[color-mix(in_oklab,var(--si-accent)_72%,#ffffff)] underline-offset-2 hover:underline';

const heading =
  (Tag: 'h2' | 'h3' | 'h4', className: string) =>
  ({ id, children }: { id?: string; children?: ReactNode }) => (
    <Tag id={id} className={cn('scroll-mt-20', className)}>
      {children}
    </Tag>
  );

const components: Components = {
  // The page title is the front matter's; a body `#` heading reads as a section heading.
  h1: heading('h2', 'mt-10 mb-3 text-[1.375rem] font-semibold leading-tight'),
  h2: heading('h2', 'mt-10 mb-3 text-[1.375rem] font-semibold leading-tight'),
  h3: heading('h3', 'mt-8 mb-2 text-[1.0625rem] font-semibold'),
  h4: heading('h4', 'mt-6 mb-2 text-[0.9375rem] font-semibold'),
  h5: heading('h4', 'mt-6 mb-2 text-[0.9375rem] font-semibold'),
  h6: heading('h4', 'mt-6 mb-2 text-[0.9375rem] font-semibold'),
  a({ href, children }) {
    if (!href) return <span>{children}</span>;
    if (href.startsWith('#'))
      return (
        <a href={href} className={LINK}>
          {children}
        </a>
      );
    if (href.startsWith('/'))
      return (
        <Link href={href} className={LINK}>
          {children}
        </Link>
      );
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
        {children}
      </a>
    );
  },
  img: ({ alt }) => (alt ? <span className="text-si-muted italic">[{alt}]</span> : null),
  pre({ node, children }) {
    return (
      <div className="relative my-4">
        <pre className="overflow-x-auto rounded-ctl border border-si-line bg-si-panel py-3 pr-12 pl-4 text-[0.8125rem] leading-[1.55]">
          {children}
        </pre>
        <CopyCode text={hastText(node as HastNode).replace(/\n$/, '')} />
      </div>
    );
  },
  ...markdownTableComponents,
};

const PROSE = [
  'min-w-0 text-[0.9375rem] leading-[1.65] text-si-fg [overflow-wrap:anywhere]',
  '[&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6',
  '[&_li]:my-1 [&_li>p]:my-1',
  '[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-(--si-line-strong) [&_blockquote]:pl-4 [&_blockquote]:text-si-muted',
  '[&_code]:font-mono [&_code]:text-[0.85em]',
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-si-panel-2 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-px',
  '[&_pre]:[overflow-wrap:normal] [&_hr]:my-8 [&_hr]:border-si-line [&_strong]:font-semibold',
  '[&_[data-slot=markdown-table]]:my-4',
].join(' ');

export function DocsMarkdown({ body }: { body: string }) {
  return (
    <div data-slot="docs-markdown" className={PROSE}>
      <Markdown
        skipHtml
        urlTransform={urlTransform}
        // biome-ignore lint/suspicious/noExplicitAny: a minimal local mdast shape instead of a types dep
        remarkPlugins={[remarkGfm, remarkHeadingIds as any]}
        components={components}
      >
        {body}
      </Markdown>
    </div>
  );
}
