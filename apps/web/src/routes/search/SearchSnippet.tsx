import { cn } from '@/shared/lib/utils';

// The server's ts_headline wraps each hit in « … ». Each run becomes a text node or a <mark>;
// the snippet is never handed to the DOM as HTML.

const OPEN = '«';
const CLOSE = '»';

export interface SnippetPart {
  text: string;
  hit: boolean;
}

export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let hit = false;
  let run = '';
  const flush = () => {
    if (!run) return;
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += run;
    else parts.push({ text: run, hit });
    run = '';
  };
  for (const ch of snippet) {
    if (ch === OPEN || ch === CLOSE) {
      flush();
      hit = ch === OPEN;
    } else run += ch;
  }
  flush();
  return parts;
}

export function SearchSnippet({ text, className }: { text: string; className?: string }) {
  return (
    <span data-slot="search-snippet" className={cn('text-si-muted', className)}>
      {snippetParts(text).map((part, i) =>
        part.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity beyond position
          <mark key={i} className="rounded-[2px] bg-si-accent/20 px-0.5 font-medium text-si-fg">
            {part.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity beyond position
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}
