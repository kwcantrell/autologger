// "New page": kind and title (and the session, for a session page). `wiki.upsert` without a pageId
// would silently update a page holding the same title or alias, so the title is checked first
// (`wiki.get` by showId + title, which also finds the team wiki's page of that name, as a show
// page can't take it); a collision links to the existing page instead of creating. In the team
// wiki there are no session pages.

import type { WikiKind } from '@autologger/contract';
import { type FormEvent, useId, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useSessions, type WikiScope } from '@/api/queries';
import { errorMessage, RpcError, rpc } from '@/api/rpc';
import { Button } from '@/shared/components/ui/button';
import { Field, FieldLabel } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/shared/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select';
import { Spinner } from '@/shared/components/ui/spinner';
import { Dialog, DialogActions } from '@/shared/ui/Dialog';
import { useWikiUpsert, WIKI_KIND_LABEL, wikiHref } from './wikiShared';

const KINDS: WikiKind[] = ['person', 'topic', 'bit', 'session', 'question'];

interface Props {
  scope: WikiScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialKind: WikiKind;
}

export function NewWikiPageDialog({ scope, open, onOpenChange, initialKind }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New page">
      {open && <NewPageForm scope={scope} initialKind={initialKind} onOpenChange={onOpenChange} />}
    </Dialog>
  );
}

function NewPageForm({ scope, initialKind, onOpenChange }: Omit<Props, 'open'>) {
  const ids = useId();
  const [, navigate] = useLocation();
  const showId = scope.showId;
  const kinds = showId ? KINDS : KINDS.filter((k) => k !== 'session');
  const [kind, setKind] = useState<WikiKind>(kinds.includes(initialKind) ? initialKind : 'person');
  const [title, setTitle] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; pageId?: string } | null>(null);
  const create = useWikiUpsert();
  const sessions = useSessions(kind === 'session' ? showId : undefined);
  const trimmed = title.trim();
  const ready = !!trimmed && (kind !== 'session' || !!sessionId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      try {
        const existing = await rpc('wiki.get', { ...scope, title: trimmed });
        setError({
          message:
            existing.teamId && showId
              ? `The team wiki has a page called “${existing.title}”; this show’s links already reach it.`
              : `A page called “${existing.title}” already exists.`,
          pageId: existing.id,
        });
        return;
      } catch (err) {
        if (!(err instanceof RpcError && err.code === 'not_found')) throw err;
      }
      const page = await create.mutateAsync({
        ...scope,
        kind,
        title: trimmed,
        bodyMd: '',
        ...(kind === 'session' && sessionId ? { sessionId } : {}),
      });
      onOpenChange(false);
      navigate(`${wikiHref(page.id)}?edit=1`);
    } catch (err) {
      setError({ message: errorMessage(err) || 'Could not create the page.' });
    } finally {
      setBusy(false);
    }
  };

  const sessionItems = (sessions.data ?? []).map((s) => ({
    value: s.id,
    label: s.title.trim() || 'Untitled session',
  }));

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <Field>
        <FieldLabel id={`${ids}-kind`}>Kind</FieldLabel>
        <RadioGroup
          aria-labelledby={`${ids}-kind`}
          value={kind}
          onValueChange={(v) => setKind(v as WikiKind)}
          className="flex flex-wrap gap-4"
        >
          {kinds.map((k) => (
            <span key={k} className="flex items-center gap-2">
              <RadioGroupItem id={`${ids}-${k}`} value={k} aria-label={WIKI_KIND_LABEL[k]} />
              <label htmlFor={`${ids}-${k}`} className="text-sm text-si-fg">
                {WIKI_KIND_LABEL[k]}
              </label>
            </span>
          ))}
        </RadioGroup>
      </Field>
      {kind === 'session' && (
        <Field>
          <FieldLabel id={`${ids}-session`}>Session</FieldLabel>
          <Select
            items={sessionItems}
            value={sessionId}
            onValueChange={(v) => setSessionId(v ? String(v) : null)}
          >
            <SelectTrigger aria-labelledby={`${ids}-session`}>
              <SelectValue
                placeholder={sessions.isPending ? 'Loading sessions…' : 'Choose a session'}
              />
            </SelectTrigger>
            <SelectContent>
              {sessionItems.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor={`${ids}-title`}>Title</FieldLabel>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={200}
          autoComplete="off"
          autoFocus
          onChange={(e) => {
            setTitle(e.target.value);
            setError(null);
          }}
        />
      </Field>
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-x-2 text-sm text-si-fg">
          <span>{error.message}</span>
          {error.pageId && (
            <Link
              href={wikiHref(error.pageId)}
              className="text-sm font-medium text-si-fg underline underline-offset-2"
              onClick={() => onOpenChange(false)}
            >
              Open that page
            </Link>
          )}
        </div>
      )}
      <DialogActions>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready || busy}>
          {busy && <Spinner role="presentation" aria-hidden="true" />}
          Create
        </Button>
      </DialogActions>
    </form>
  );
}
