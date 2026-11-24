// Move a page between a show wiki and its team's shared wiki (wiki.move). A show page goes to the
// team wiki in one step; a team page asks which show (one the user can write) takes it.

import type { WikiPage } from '@autologger/contract';
import { useId, useState } from 'react';
import { wikiScopeOf } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { showToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui/button';
import { Field, FieldLabel } from '@/shared/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select';
import { Spinner } from '@/shared/components/ui/spinner';
import { Dialog, DialogActions } from '@/shared/ui/Dialog';
import { useWikiMove } from './wikiShared';

interface Props {
  page: WikiPage;
  /** The team of the page's wiki. */
  teamId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MoveWikiPageDialog({ page, teamId, open, onOpenChange }: Props) {
  const toTeam = !!page.showId;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={toTeam ? 'Move to the team wiki?' : 'Move to a show'}
    >
      {open && <MoveForm page={page} teamId={teamId} onOpenChange={onOpenChange} />}
    </Dialog>
  );
}

function MoveForm({ page, teamId, onOpenChange }: Omit<Props, 'open'>) {
  const ids = useId();
  const { allShows, teams } = useActive();
  const toTeam = !!page.showId;
  const team = teams.find((t) => t.id === teamId);
  const shows = allShows
    .filter((s) => s.teamId === teamId && (s.access === 'write' || s.access === 'manage'))
    .map((s) => ({ value: s.id, label: s.name }));
  const [showId, setShowId] = useState<string | null>(shows.length === 1 ? shows[0]!.value : null);
  const [error, setError] = useState<string | null>(null);
  const move = useWikiMove(wikiScopeOf(page));

  const submit = () => {
    setError(null);
    move.mutate(toTeam ? { pageId: page.id, teamId } : { pageId: page.id, showId: showId! }, {
      onSuccess: (moved) => {
        onOpenChange(false);
        const bad = moved.badCitations.length;
        showToast(
          `Moved “${page.title}” to ${toTeam ? 'the team wiki' : (shows.find((s) => s.value === showId)?.label ?? 'the show')}.${bad ? ` ${bad} citation${bad === 1 ? '' : 's'} now point outside it.` : ''}`,
        );
      },
      onError: (e) => setError(errorMessage(e) || 'The page was not moved.'),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {toTeam ? (
        <p className="m-0 text-sm text-si-muted">
          “{page.title}” moves to {team ? `${team.name}’s` : 'the'} shared wiki. [[Links]] to it
          from every show of the team will reach it, unless a show has its own page of that name.
          Undo it from the change log.
        </p>
      ) : (
        <Field>
          <FieldLabel id={`${ids}-show`}>Show</FieldLabel>
          <Select
            items={shows}
            value={showId}
            onValueChange={(v) => setShowId(v ? String(v) : null)}
          >
            <SelectTrigger aria-labelledby={`${ids}-show`}>
              <SelectValue placeholder={shows.length ? 'Choose a show' : 'No show you can edit'} />
            </SelectTrigger>
            <SelectContent>
              {shows.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-si-danger">
          {error}
        </p>
      )}
      <DialogActions>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={move.isPending || (!toTeam && !showId)}>
          {move.isPending && <Spinner role="presentation" aria-hidden="true" />}
          Move
        </Button>
      </DialogActions>
    </div>
  );
}
