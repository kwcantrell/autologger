import { ChevronRight, Plus } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { qk, useCapabilities } from '@/api/queries';
import { errorMessage, rpc } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { NativeSelect } from '@/components/NativeSelect';
import { FRAME_RATES, parseTimecode } from '@/lib/timecode';
import { enqueueUpload, probeDuration } from '@/session/audio/uploads';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { Textarea } from '@/shared/components/ui/textarea';
import { cn } from '@/shared/lib/utils';
import { Dialog, DialogActions } from '@/shared/ui/Dialog';
import { useQueryClient } from '@tanstack/react-query';

const today = () => new Date().toLocaleDateString('en-CA');

export function NewSessionModal({ onClose }: { onClose: () => void }) {
  const active = useActive();
  const caps = useCapabilities().data;
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const writable = useMemo(() => active.shows.filter((s) => s.access !== 'read'), [active.shows]);
  const [showId, setShowId] = useState(active.show && active.show.access !== 'read' ? active.show.id : (writable[0]?.id ?? ''));
  const show = writable.find((s) => s.id === showId);
  const [title, setTitle] = useState('');
  const [episode, setEpisode] = useState('');
  const [date, setDate] = useState(today());
  const [fps, setFps] = useState<number | null>(null);
  const [startTc, setStartTc] = useState('00:00:00:00');
  const [notes, setNotes] = useState('');
  const [tcOpen, setTcOpen] = useState(false);
  const [srcOpen, setSrcOpen] = useState(false);
  const [ytUrl, setYtUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const frameRate = fps ?? show?.defaultFrameRate ?? 24;
  const tcValid = parseTimecode(startTc, frameRate) != null;
  const ytReason = caps && !caps.youtube ? "YouTube import isn't available on this server." : null;
  const fileReason = caps && !caps.storage ? "Audio storage isn't configured on this server." : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!show) return;
    if (show.titleSuffix === 'episode' && !episode.trim() && !title.trim()) {
      setError('Enter an episode (this show names sessions by episode number) or a title.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const s = await rpc('sessions.create', {
        showId: show.id,
        title: title.trim() || undefined,
        episode: episode.trim() || undefined,
        episodeDate: date || undefined,
        frameRate,
        startTimecode: startTc.trim() && startTc.trim() !== '00:00:00:00' ? startTc.trim() : undefined,
        notes: notes.trim() || undefined,
      });
      void qc.invalidateQueries({ queryKey: qk.sessionsAll });
      void qc.invalidateQueries({ queryKey: qk.shows });
      if (file) {
        enqueueUpload({
          sessionId: s.id,
          blob: file,
          mimeType: file.type || 'audio/mpeg',
          origin: 'file',
          fileName: file.name,
          startSec: 0,
          durationSec: await probeDuration(file),
        });
      }
      if (ytUrl.trim()) {
        try {
          await rpc('media.importYoutube', { sessionId: s.id, url: ytUrl.trim() });
        } catch (err) {
          showToast(`Session created, but the YouTube import didn't start: ${errorMessage(err)}`, true);
        }
      }
      onClose();
      navigate(`/sessions/${encodeURIComponent(s.id)}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New session" hideTitle className="md:max-w-lg">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Plus className="size-5" aria-hidden="true" />
          <h2 className="m-0 text-[1rem] font-semibold uppercase tracking-[0.06em]">New session</h2>
        </div>

        <Field>
          <FieldLabel htmlFor="ns-show">Show</FieldLabel>
          {writable.length === 0 ? (
            <p className="m-0 text-sm text-si-muted">
              No show in {active.team?.name ?? 'this team'} lets you create sessions. Ask a team owner or admin for write access, or add a show in Settings → Shows.
            </p>
          ) : (
            <NativeSelect id="ns-show" value={showId} onChange={(e) => setShowId(e.target.value)}>
              {writable.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="ns-title">Title (optional)</FieldLabel>
          <Input id="ns-title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={show ? `${show.code} ${show.titleSuffix === 'episode' ? `#${episode || show.nextEpisode}` : show.titleSuffix === 'date' ? date : ''}`.trim() : ''} />
          <FieldDescription>Left empty, the show code plus {show?.titleSuffix === 'episode' ? 'episode number' : show?.titleSuffix === 'date' ? 'date' : 'nothing else'} names it.</FieldDescription>
        </Field>

        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Field>
            <FieldLabel htmlFor="ns-episode">Episode</FieldLabel>
            <Input id="ns-episode" maxLength={40} value={episode} placeholder={show ? String(show.nextEpisode) : ''} onChange={(e) => setEpisode(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="ns-date">Date</FieldLabel>
            <Input id="ns-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="ns-notes">Notes (optional)</FieldLabel>
          <Textarea id="ns-notes" placeholder="Session notes" maxLength={10000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <div>
          <Button type="button" variant="ghost" className="px-1" aria-expanded={tcOpen} onClick={() => setTcOpen((v) => !v)}>
            <ChevronRight className={cn('transition-transform motion-reduce:transition-none', tcOpen && 'rotate-90')} aria-hidden="true" />
            Timecode settings — {frameRate} fps · start {startTc}
          </Button>
          {tcOpen && (
            <div className="mt-2 grid grid-cols-2 gap-3 max-md:grid-cols-1">
              <Field>
                <FieldLabel htmlFor="ns-fps">Frame rate</FieldLabel>
                <NativeSelect id="ns-fps" value={String(frameRate)} onChange={(e) => setFps(Number(e.target.value))}>
                  {FRAME_RATES.map((r) => (
                    <option key={r} value={r}>
                      {r} fps
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="ns-tc">Start timecode</FieldLabel>
                <Input id="ns-tc" className="font-tc" value={startTc} aria-invalid={!tcValid || undefined} onChange={(e) => setStartTc(e.target.value)} />
                {!tcValid && <FieldDescription className="text-si-danger">Use HH:MM:SS:FF with frames below {Math.round(frameRate)}.</FieldDescription>}
              </Field>
            </div>
          )}
        </div>

        <div>
          <Button type="button" variant="ghost" className="px-1" aria-expanded={srcOpen} onClick={() => setSrcOpen((v) => !v)}>
            <ChevronRight className={cn('transition-transform motion-reduce:transition-none', srcOpen && 'rotate-90')} aria-hidden="true" />
            Import audio{!srcOpen && (file || ytUrl) ? ' — source added' : ''}
          </Button>
          {srcOpen && (
            <div className="mt-2 flex flex-col gap-3">
              <Field>
                <FieldLabel htmlFor="ns-yt">YouTube link</FieldLabel>
                <Input id="ns-yt" type="url" disabled={!!ytReason || !!file} placeholder="https://www.youtube.com/watch?v=…" value={ytUrl} onChange={(e) => setYtUrl(e.target.value)} />
                {ytReason && <FieldDescription>{ytReason}</FieldDescription>}
              </Field>
              <Field>
                <FieldLabel htmlFor="ns-file">Or an audio file</FieldLabel>
                <Input id="ns-file" type="file" accept="audio/*,video/*" disabled={!!fileReason || !!ytUrl.trim()} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                {fileReason && <FieldDescription>{fileReason}</FieldDescription>}
              </Field>
            </div>
          )}
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogActions>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !show || !tcValid}>
            {busy ? 'Creating…' : 'Create & open'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
