// The page editor: title, alias chips (not on session pages), Write / Preview tabs over the
// Markdown body. Controlled: the page view owns the draft.

import { XIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import { Textarea } from '@/shared/components/ui/textarea';
import { WikiMarkdown } from './WikiMarkdown';
import { useSessionTitles, type WikiResolver } from './wikiShared';

export interface WikiDraft {
  title: string;
  body: string;
  aliases: string[];
}

interface Props {
  draft: WikiDraft;
  onChange: (draft: WikiDraft) => void;
  showAliases: boolean;
  resolve: WikiResolver;
  showId: string;
  /** The page's own session, which short citations resolve to. */
  sessionId?: string | null;
}

export function WikiEditor({ draft, onChange, showAliases, resolve, showId, sessionId }: Props) {
  const sessionTitle = useSessionTitles(showId, draft.body, sessionId);
  const titleId = useId();
  const aliasId = useId();
  const [alias, setAlias] = useState('');

  const addAlias = () => {
    const next = alias.trim();
    if (!next) return;
    const lower = next.toLocaleLowerCase();
    if (!draft.aliases.some((a) => a.toLocaleLowerCase() === lower))
      onChange({ ...draft, aliases: [...draft.aliases, next] });
    setAlias('');
  };

  return (
    <div data-slot="wiki-editor" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={titleId}>Title</Label>
        <Input
          id={titleId}
          value={draft.title}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
      </div>

      {showAliases && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={aliasId}>Aliases</Label>
          {draft.aliases.length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {draft.aliases.map((a) => (
                <li key={a}>
                  <Badge variant="outline" className="gap-1 pr-1 normal-case tracking-normal">
                    {a}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove alias ${a}`}
                      className="size-auto rounded-sm border-0 text-si-dim not-disabled:hover:bg-transparent not-disabled:hover:text-si-fg"
                      onClick={() =>
                        onChange({ ...draft, aliases: draft.aliases.filter((x) => x !== a) })
                      }
                    >
                      <XIcon aria-hidden="true" className="size-3" />
                    </Button>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Input
              id={aliasId}
              placeholder="Add an alias, then press Enter"
              value={alias}
              maxLength={200}
              autoComplete="off"
              onChange={(e) => setAlias(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addAlias();
                }
              }}
            />
            <Button type="button" variant="outline" onClick={addAlias} disabled={!alias.trim()}>
              Add
            </Button>
          </div>
        </div>
      )}

      <Tabs defaultValue="write" className="gap-2">
        <TabsList variant="line" aria-label="Editor view">
          <TabsTrigger value="write">Write</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
        <TabsContent value="write">
          <Textarea
            aria-label="Page text"
            value={draft.body}
            onChange={(e) => onChange({ ...draft, body: e.target.value })}
            className="min-h-[18rem] font-mono text-[0.85rem] leading-relaxed"
            spellCheck
          />
          <p className="m-0 mt-1.5 text-xs text-si-dim">
            Markdown. Link another page with <code className="font-mono">[[Title]]</code> or{' '}
            <code className="font-mono">[[Title|label]]</code>, cite a moment with{' '}
            <code className="font-mono">[quote](/sessions/id?t=seconds&amp;to=seconds)</code>
            {sessionId ? (
              <>
                {' '}
                or, for this page’s session,{' '}
                <code className="font-mono">[quote](@seconds-seconds)</code>
              </>
            ) : null}
            .
          </p>
        </TabsContent>
        <TabsContent value="preview">
          <div className="min-h-[18rem] rounded-ctl border border-si-line px-4 py-2">
            {draft.body.trim() ? (
              <WikiMarkdown
                body={draft.body}
                resolve={resolve}
                sessionTitle={sessionTitle}
                sessionId={sessionId}
              />
            ) : (
              <p className="m-0 py-2 text-sm text-si-muted">Nothing to preview yet.</p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
