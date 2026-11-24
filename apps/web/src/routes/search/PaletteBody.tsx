// The command palette's contents: debounced server search grouped into sessions, moments and wiki
// pages (cmdk with its own filter off). Lazy-loaded by SearchPalette the first time it opens.

import { BookOpenIcon, SearchIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useSearch } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/shared/components/ui/command';
import { Spinner } from '@/shared/components/ui/spinner';
import { fmtDateOnly } from '@/shared/utils/fmtDateOnly';
import { SearchSnippet } from './SearchSnippet';
import {
  groupHits,
  hitHref,
  isSearchable,
  momentLabel,
  SEARCH_DEBOUNCE_MS,
  searchPageHref,
  showAndDate,
  untitled,
  wikiHitPlace,
} from './searchLinks';

/** Results fetched per palette search (all kinds, ranked together); each group shows 5. */
const PALETTE_FETCH = 30;
const PER_GROUP = 5;

export function PaletteBody({ onDone }: { onDone: () => void }) {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const searchable = isSearchable(query);
  const { data, isFetching, isError, error } = useSearch(
    isSearchable(debounced) ? { query: debounced.trim(), limit: PALETTE_FETCH } : null,
  );
  const settled = debounced === query && !isFetching;
  const groups = searchable && data && settled ? groupHits(data) : null;
  const empty = groups && !groups.sessions.length && !groups.moments.length && !groups.wiki.length;

  // cmdk keeps its highlight on whatever item existed first ("See all results" while searching);
  // when fresh results land, highlight the top one so Enter opens it.
  const first = groups
    ? groups.sessions[0]
      ? `session:${groups.sessions[0].id}`
      : groups.moments[0]
        ? `moment:${groups.moments[0].kind}:${groups.moments[0].id}`
        : groups.wiki[0]
          ? `wiki:${groups.wiki[0].id}`
          : 'see-all'
    : 'see-all';
  const [selected, setSelected] = useState('see-all');
  useEffect(() => setSelected(first), [first]);

  const go = (href: string) => () => {
    onDone();
    navigate(href);
  };

  let status: ReactNode = null;
  if (!searchable) status = 'Type at least 2 characters to search.';
  else if (isError && settled) status = errorMessage(error) || 'Search failed.';
  else if (!groups)
    status = (
      <span className="inline-flex items-center gap-2">
        <Spinner role="presentation" aria-hidden="true" className="size-3.5" /> Searching…
      </span>
    );
  else if (empty) status = `No results for “${query.trim()}”.`;

  return (
    <Command
      shouldFilter={false}
      value={selected}
      onValueChange={setSelected}
      className="bg-transparent text-si-fg"
    >
      <CommandInput
        ref={inputRef}
        value={query}
        onValueChange={setQuery}
        placeholder="Search sessions, transcripts, topics, events…"
        aria-label="Search"
        // The global text-input chrome (border, ground fill) would box the palette's input.
        className="rounded-none border-0 bg-transparent px-0 focus:border-0"
      />
      <CommandList className="max-h-[min(60vh,28rem)]">
        {status && (
          <div role="status" className="px-3 py-6 text-center text-sm text-si-muted">
            {status}
          </div>
        )}
        {groups && groups.sessions.length > 0 && (
          <CommandGroup heading="Sessions">
            {groups.sessions.slice(0, PER_GROUP).map((h) => (
              <CommandItem
                key={h.id}
                value={`session:${h.id}`}
                onSelect={go(hitHref(h))}
                className="flex-col items-start gap-0.5"
              >
                <span className="flex w-full min-w-0 items-baseline gap-2">
                  <span className="truncate font-medium">{untitled(h.title)}</span>
                  <span className="ml-auto shrink-0 text-xs text-si-dim">{showAndDate(h)}</span>
                </span>
                {h.snippet && <SearchSnippet text={h.snippet} className="line-clamp-2 text-xs" />}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {groups && groups.moments.length > 0 && (
          <CommandGroup heading="Moments">
            {groups.moments.slice(0, PER_GROUP).map((h) => (
              <CommandItem
                key={`${h.kind}:${h.id}`}
                value={`moment:${h.kind}:${h.id}`}
                onSelect={go(hitHref(h))}
                className="flex-col items-start gap-0.5"
              >
                <span className="flex w-full min-w-0 items-baseline gap-2 text-xs text-si-dim">
                  <span data-slot="moment-label" className="shrink-0 font-medium">
                    {momentLabel(h)}
                  </span>
                  <span className="truncate">{untitled(h.sessionTitle)}</span>
                  {h.sessionDate && (
                    <span className="ml-auto shrink-0">{fmtDateOnly(h.sessionDate)}</span>
                  )}
                </span>
                <SearchSnippet text={h.snippet} className="line-clamp-2 text-sm" />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {groups && groups.wiki.length > 0 && (
          <CommandGroup heading="Wiki pages">
            {groups.wiki.slice(0, PER_GROUP).map((h) => (
              <CommandItem
                key={h.id}
                value={`wiki:${h.id}`}
                onSelect={go(hitHref(h))}
                className="flex-col items-start gap-0.5"
              >
                <span className="flex w-full min-w-0 items-baseline gap-2">
                  <BookOpenIcon
                    aria-hidden="true"
                    className="size-3.5 shrink-0 self-center text-si-dim"
                  />
                  <span className="truncate font-medium">{h.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-si-dim">{wikiHitPlace(h)}</span>
                </span>
                {h.snippet && <SearchSnippet text={h.snippet} className="line-clamp-2 text-xs" />}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {searchable && (
          <>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="see-all" onSelect={go(searchPageHref(query))}>
                <SearchIcon />
                <span>See all results</span>
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}
