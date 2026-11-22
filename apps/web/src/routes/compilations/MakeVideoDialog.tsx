// "Make video": a confirm step in front of compilations.create. The caller hands over ranges it
// already has (a wiki page's citations, a session's topics); the dialog shows which become clips —
// each can be ticked or unticked — which are left out and why (only YouTube imports have video), the total
// length and an editable title, then creates the compilation and opens /compilations. No clip
// editing beyond that: agents build finer compilations over MCP.

import { MAX_CLIP_SEC } from '@autologger/contract';
import { type FormEvent, useId, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { qk, useCapabilities, useOpMutation, useSessions } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { selectShow, useActive } from '@/app/useActive';
import { fmtShort } from '@/lib/timecode';
import { showToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui/button';
import { Checkbox } from '@/shared/components/ui/checkbox';
import { Field, FieldLabel } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { Spinner } from '@/shared/components/ui/spinner';
import { Dialog, DialogActions } from '@/shared/ui/Dialog';
import {
  type ClipCandidate,
  DEFAULT_CLIP_SEC,
  limitProblem,
  type PlannedClip,
  planClips,
  totalSec,
} from './clipPlan';

/**
 * Why "Make video" can't be used in this show at all, or null. `canWrite`: the user's access to
 * the show; capabilities false means the server can't download from YouTube or store video.
 */
export function useMakeVideoBlocked(canWrite: boolean, showName?: string): string | null {
  const caps = useCapabilities().data;
  if (!canWrite)
    return `You have read-only access to ${showName ?? 'this show'}. Ask a team admin for write access to make videos.`;
  if (caps && !caps.storage)
    return 'Video compilations need media storage, which is not configured on this server.';
  if (caps && !caps.youtube) return 'YouTube downloads are turned off on this server.';
  return null;
}

interface Props {
  showId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTitle: string;
  candidates: ClipCandidate[];
  /** What the ranges are, for the description ("page’s citations", "session’s topics"). */
  sourceNoun: string;
  /** Start with every clip ticked (a page's citations) or none (a session's topics, to pick from). */
  startTicked: boolean;
  /** How the clip ranges were chosen, shown under the list (search hits are points, not ranges). */
  note?: string;
  /** The caller is still fetching the candidates (search's "Make video" loads a show's moments). */
  loading?: boolean;
}

export function MakeVideoDialog({ open, onOpenChange, ...rest }: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Make a video"
      className="md:!max-w-[40rem]"
      description={`One video from the ${rest.sourceNoun}, cut from the YouTube videos their sessions were imported from.`}
    >
      {open && <MakeVideoForm onOpenChange={onOpenChange} {...rest} />}
    </Dialog>
  );
}

function rangeLabel(c: PlannedClip): string {
  return `${fmtShort(c.startSec)}–${fmtShort(c.endSec)}`;
}

function MakeVideoForm({
  showId,
  onOpenChange,
  defaultTitle,
  candidates,
  sourceNoun,
  startTicked,
  note,
  loading,
}: Omit<Props, 'open'>) {
  const ids = useId();
  const [, navigate] = useLocation();
  const { allShows, show: activeShow } = useActive();
  const sessions = useSessions(showId);
  const [title, setTitle] = useState(defaultTitle.slice(0, 200));
  // Ticked clip keys; null until the user changes the selection (then `startTicked` applies).
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useOpMutation('compilations.create', {
    invalidate: () => [qk.compilations(showId)],
  });

  const plan = useMemo(
    () => (sessions.data ? planClips(candidates, sessions.data) : null),
    [candidates, sessions.data],
  );

  if (sessions.isError)
    return (
      <div role="alert" className="flex flex-col items-start gap-3 text-sm text-si-fg">
        <p className="m-0">{errorMessage(sessions.error) || 'The sessions could not be loaded.'}</p>
        <Button variant="outline" onClick={() => void sessions.refetch()}>
          Try again
        </Button>
      </div>
    );
  if (!plan || loading)
    return (
      <div role="status" className="flex items-center gap-2 py-6 text-sm text-si-muted">
        <Spinner role="presentation" aria-hidden="true" className="size-4" />{' '}
        {loading ? 'Finding the moments…' : 'Checking the sessions…'}
      </div>
    );

  const ticked = picked ?? new Set(startTicked ? plan.clips.map((c) => c.key) : []);
  const chosen = plan.clips.filter((c) => ticked.has(c.key));
  const problem = limitProblem(chosen);
  const anyDefault = plan.clips.some((c) => c.defaultLength);
  const trimmedMax = plan.clips.some(
    (c) => c.trimmed && c.endSec - c.startSec >= MAX_CLIP_SEC - 0.01,
  );
  const trimmedTitle = title.trim();

  const toggle = (key: string, on: boolean) => {
    setError(null);
    const next = new Set(ticked);
    if (on) next.add(key);
    else next.delete(key);
    setPicked(next);
  };
  const allTicked = chosen.length === plan.clips.length;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || !trimmedTitle || create.isPending) return;
    setError(null);
    create.mutate(
      {
        showId,
        title: trimmedTitle,
        clips: chosen.map((c) => ({
          sessionId: c.sessionId,
          startSec: c.startSec,
          endSec: c.endSec,
          ...(c.label ? { label: c.label } : {}),
        })),
      },
      {
        onSuccess: (cmp) => {
          // /compilations lists the active show's compilations.
          const show = allShows.find((s) => s.id === showId);
          if (show && activeShow?.id !== showId) selectShow(show);
          onOpenChange(false);
          showToast(`Building “${cmp.title}”.`);
          navigate('/compilations');
        },
        onError: (err) => setError(errorMessage(err) || 'The compilation was not created.'),
      },
    );
  };

  if (plan.clips.length === 0)
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p role="alert" className="m-0 text-si-fg">
          None of the {sourceNoun} can be made into a video. Compilations are cut from YouTube
          videos, so only sessions imported from YouTube (with their audio stored) can be used.
        </p>
        <SkippedList skipped={plan.skipped} />
        <DialogActions>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogActions>
      </div>
    );

  return (
    <form className="flex min-w-0 flex-col gap-4" onSubmit={submit}>
      <Field>
        <FieldLabel htmlFor={`${ids}-title`}>Title</FieldLabel>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => {
            setTitle(e.target.value);
            setError(null);
          }}
        />
      </Field>

      <section aria-labelledby={`${ids}-clips`} className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h3 id={`${ids}-clips`} className="m-0 text-sm font-semibold text-si-fg">
            {chosen.length} of {plan.clips.length} clip{plan.clips.length === 1 ? '' : 's'}
          </h3>
          <span className="flex items-baseline gap-3 text-xs font-normal">
            {plan.clips.length > 1 && (
              <button
                type="button"
                onClick={() => setPicked(new Set(allTicked ? [] : plan.clips.map((c) => c.key)))}
                className="cursor-pointer border-0 bg-transparent p-0 text-xs text-si-muted underline decoration-(--si-line-strong) underline-offset-2 hover:text-si-fg"
              >
                {allTicked ? 'Clear' : 'Select all'}
              </button>
            )}
            <span className="font-mono text-si-muted">Total {fmtShort(totalSec(chosen))}</span>
          </span>
        </div>
        <ol className="m-0 flex max-h-[min(22rem,45vh)] list-none flex-col gap-1 overflow-y-auto p-0">
          {plan.clips.map((c, i) => {
            const on = ticked.has(c.key);
            return (
              <li key={c.key} className="flex min-w-0 items-start gap-2.5 py-1 text-sm">
                <Checkbox
                  id={`${ids}-c${c.key}`}
                  checked={on}
                  onCheckedChange={(v) => toggle(c.key, v === true)}
                  className="mt-0.5"
                />
                <label htmlFor={`${ids}-c${c.key}`} className="flex min-w-0 flex-col gap-0.5">
                  <span className="min-w-0 break-words text-si-fg">
                    <span className="text-si-dim">{i + 1}. </span>
                    {c.sessionTitle}{' '}
                    <span className="font-mono text-xs whitespace-nowrap text-si-muted">
                      {rangeLabel(c)}
                    </span>
                  </span>
                  {(c.label || c.defaultLength || c.trimmed) && (
                    <span className="min-w-0 text-xs break-words text-si-dim">
                      {c.label}
                      {c.defaultLength &&
                        `${c.label ? ' · ' : ''}no end given, ${DEFAULT_CLIP_SEC} s used`}
                      {c.trimmed && `${c.label || c.defaultLength ? ' · ' : ''}cut to fit`}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ol>
        {note && <p className="m-0 text-xs text-si-dim">{note}</p>}
        {(anyDefault || trimmedMax) && (
          <p className="m-0 text-xs text-si-dim">
            {anyDefault &&
              `Ranges without an end run ${DEFAULT_CLIP_SEC} s from their start (or to the end of the video). `}
            {trimmedMax && `Clips are at most ${MAX_CLIP_SEC / 60} minutes long.`}
          </p>
        )}
      </section>

      {plan.skipped.length > 0 && (
        <details className="min-w-0 text-sm">
          <summary className="cursor-pointer text-si-muted hover:text-si-fg">
            {plan.skipped.length} left out
          </summary>
          <SkippedList skipped={plan.skipped} />
        </details>
      )}

      <p className="m-0 text-xs text-si-dim">
        The server downloads just these sections and joins them into one MP4; it appears on the
        Compilations page and takes a few seconds per clip-minute to build.
      </p>

      {chosen.length === 0 && !error && (
        <p className="m-0 text-sm text-si-muted">Tick the clips to put in the video.</p>
      )}
      {(error || (problem && chosen.length > 0)) && (
        <p role="alert" className="m-0 text-sm break-words text-si-danger">
          {error ?? problem}
        </p>
      )}

      <DialogActions>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!!problem || !trimmedTitle || create.isPending}>
          {create.isPending && <Spinner role="presentation" aria-hidden="true" />}
          Make video
        </Button>
      </DialogActions>
    </form>
  );
}

function SkippedList({ skipped }: { skipped: ReturnType<typeof planClips>['skipped'] }) {
  return (
    <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
      {skipped.map((s) => (
        <li key={s.key} className="min-w-0 text-sm break-words">
          <span className="text-si-fg">{s.sessionTitle ?? 'Unknown session'}</span>{' '}
          <span className="font-mono text-xs text-si-muted">{fmtShort(s.startSec)}</span>
          {s.label && <span className="text-si-muted"> · {s.label}</span>}
          <span className="block text-xs text-si-dim">{s.reason}</span>
        </li>
      ))}
    </ul>
  );
}
