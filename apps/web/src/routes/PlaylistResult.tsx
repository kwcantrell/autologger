// A playlist import's preview (dryRun) or result: the sessions it will create or created, and the
// videos it skips. Presentational (props in, markup out), so the landing page mock renders it too.

import type { PlaylistImport } from '@autologger/contract';
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { fmtSec } from '@/lib/timecode';
import { Badge } from '@/shared/components/ui/badge';

const SKIP_REASON: Record<PlaylistImport['skipped'][number]['reason'], string> = {
  already_imported: 'Already in the show',
  unavailable: 'Private or deleted',
};

export function PlaylistResult({
  data,
  onOpenSession,
}: {
  data: PlaylistImport;
  onOpenSession: () => void;
}) {
  const n = data.created.length;
  return (
    <section aria-live="polite" className="flex min-w-0 flex-col gap-3">
      <p className="m-0 text-sm">
        {data.playlistTitle ? <strong>{data.playlistTitle}</strong> : 'This playlist'}
        {data.dryRun
          ? n
            ? ` · ${n} new session${n === 1 ? '' : 's'} will be created.`
            : ' · nothing new to import.'
          : ` · ${n} session${n === 1 ? '' : 's'} created. Each session’s Audio menu shows its download and transcription.`}
      </p>
      {data.dryRun && data.downloadCheck.status === 'blocked' && (
        <p role="alert" className="m-0 text-sm text-si-danger">
          YouTube won’t let the server download these videos, so importing would fail.{' '}
          {data.downloadCheck.message}
        </p>
      )}
      {n > 0 && (
        <ResultList label={data.dryRun ? 'Will be created' : 'Created'}>
          {data.created.map((c) => (
            <li key={c.videoId} className={ROW}>
              <span className="w-10 shrink-0 font-tc text-xs tabular-nums text-si-muted">
                #{c.episode}
              </span>
              <span className="min-w-0 flex-1 truncate" title={c.title}>
                {c.sessionId ? (
                  <Link
                    className={LINK}
                    onClick={onOpenSession}
                    href={`/sessions/${encodeURIComponent(c.sessionId)}`}
                  >
                    {c.title}
                  </Link>
                ) : (
                  c.title
                )}
              </span>
              <span className="shrink-0 font-tc text-xs tabular-nums text-si-muted">
                {c.durationSec != null ? fmtSec(c.durationSec) : '—'}
              </span>
            </li>
          ))}
        </ResultList>
      )}
      {data.skipped.length > 0 && (
        <ResultList label={`Skipped (${data.skipped.length})`}>
          {data.skipped.map((s) => (
            <li key={s.videoId} className={ROW}>
              <span className="min-w-0 flex-1 truncate" title={s.title}>
                {s.sessionId ? (
                  <Link
                    className={LINK}
                    onClick={onOpenSession}
                    href={`/sessions/${encodeURIComponent(s.sessionId)}`}
                  >
                    {s.title || s.videoId}
                  </Link>
                ) : (
                  s.title || s.videoId
                )}
              </span>
              <Badge variant="outline" className="shrink-0">
                {SKIP_REASON[s.reason]}
              </Badge>
            </li>
          ))}
        </ResultList>
      )}
    </section>
  );
}

const ROW = 'flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm';
const LINK = 'text-si-fg underline underline-offset-2 hover:text-si-accent';

function ResultList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="m-0 font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim">
        {label}
      </h3>
      <ul className="m-0 flex max-h-52 list-none flex-col overflow-y-auto rounded-ctl border border-si-line p-0 divide-y divide-si-line">
        {children}
      </ul>
    </div>
  );
}
