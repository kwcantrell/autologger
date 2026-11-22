// Agent-authored markdown, rendered without raw HTML. Only http(s) links survive; images render as
// their alt text (no remote fetches from a spec).

import ReactMarkdown, { type Components } from 'react-markdown';

const SAFE_URL = /^https?:\/\//i;

function urlTransform(url: string, key: string): string | null {
  if (key !== 'href') return null;
  return SAFE_URL.test(url.trim()) ? url.trim() : null;
}

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-(--si-accent) underline-offset-2 hover:underline"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => (alt ? <span className="text-si-muted italic">[{alt}]</span> : null),
  h1: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-[1.05rem] font-semibold text-si-fg first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h4 className="mt-3 mb-1.5 text-[0.95rem] font-semibold text-si-fg first:mt-0">{children}</h4>
  ),
  h3: ({ children }) => (
    <h5 className="mt-2.5 mb-1 text-[0.875rem] font-semibold text-si-fg first:mt-0">{children}</h5>
  ),
  h4: ({ children }) => (
    <h6 className="mt-2 mb-1 text-[0.85rem] font-semibold text-si-fg first:mt-0">{children}</h6>
  ),
  h5: ({ children }) => (
    <h6 className="mt-2 mb-1 text-[0.85rem] font-semibold text-si-fg first:mt-0">{children}</h6>
  ),
  h6: ({ children }) => (
    <h6 className="mt-2 mb-1 text-[0.85rem] font-semibold text-si-fg first:mt-0">{children}</h6>
  ),
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-si-line pl-3 text-si-muted">
      {children}
    </blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded bg-si-bg px-1 py-px font-tc text-[0.78rem]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-ctl bg-si-bg p-2 text-[0.78rem]">{children}</pre>
  ),
  hr: () => <hr className="my-3 border-si-line" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[0.78rem]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-si-line px-2 py-1 text-left font-semibold text-si-dim">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-b border-white/5 px-2 py-1">{children}</td>,
};

export function SpecMarkdown({ source }: { source: string }) {
  return (
    <div className="min-w-0 text-[0.85rem] leading-[1.5] text-si-fg [overflow-wrap:anywhere]">
      <ReactMarkdown skipHtml urlTransform={urlTransform} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
