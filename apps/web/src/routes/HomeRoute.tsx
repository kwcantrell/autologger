import { ArrowRight, Plus } from 'lucide-react';
import { Link } from 'wouter';
import { useSessions } from '@/api/queries';
import { useActive } from '@/app/useActive';
import { newSessionOpen, settingsOpen } from '@/lib/store';
import { Button } from '@/shared/components/ui/button';
import { Card } from '@/shared/components/ui/card';
import { fmtDateOnly } from '@/shared/utils/fmtDateOnly';

const RESUME_CARD =
  'group relative box-border w-full max-w-[24rem] items-stretch gap-[0.35rem] rounded-card border border-(--si-line-strong) bg-si-panel-2 px-6 py-5 text-left text-si-fg [transition:border-color_0.15s_ease,background_0.15s_ease] hover-always:border-[color-mix(in_srgb,var(--si-accent)_35%,var(--si-line))] has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-(--si-accent)';

export function HomeRoute() {
  const active = useActive();
  const sessions = useSessions(active.show?.id);
  const recent = (sessions.data ?? []).find((s) => !s.archivedAt);

  return (
    <div
      id="home-launch"
      className="relative z-[1] flex min-h-[calc(100dvh-var(--topbar-h)-4rem)] w-full flex-col items-center justify-center px-6 py-16 text-center"
    >
      <div className="flex w-full max-w-[26rem] flex-col items-center gap-7">
        <header className="flex flex-col items-center gap-2">
          <h1 className="m-0 font-league-gothic text-[3.4rem] font-bold uppercase leading-none tracking-[0.03em] text-si-fg">
            AutoLogger
          </h1>
          <p className="m-0 max-w-[20rem] text-[0.9rem] leading-[1.5] text-si-muted">
            Every session becomes a searchable, visual record — events, transcripts, topics.
          </p>
        </header>

        <div className="flex w-full flex-col items-center gap-3">
          {recent && (
            <section className="flex w-full justify-center" aria-labelledby="home-resume-title">
              <Card className={RESUME_CARD}>
                <h2 id="home-resume-title" className="m-0 truncate text-[1.05rem] font-semibold leading-snug">
                  {recent.title || 'Untitled session'}
                </h2>
                <p className="m-0 text-[0.72rem] leading-[1.35] text-si-muted">
                  {fmtDateOnly(recent.episodeDate ?? recent.createdAt)} · {recent.eventCount} events
                </p>
                <Link
                  href={`/sessions/${encodeURIComponent(recent.id)}`}
                  aria-label={`Jump back in to ${recent.title}`}
                  className="mt-1.5 inline-flex items-center gap-1.5 self-start text-sm font-medium text-(--si-accent-text) outline-none after:absolute after:inset-0 after:rounded-card after:content-['']"
                >
                  Jump back in
                  <ArrowRight
                    className="size-4 [transition:transform_0.15s_ease] group-hover-always:translate-x-[2px] motion-reduce:transition-none"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                </Link>
              </Card>
            </section>
          )}

          {active.canWriteShow ? (
            <Button variant={recent ? 'outline' : 'default'} id="home-new-session" onClick={() => newSessionOpen.set(true)}>
              <Plus strokeWidth={2} aria-hidden="true" />
              {recent ? 'New session' : 'Start a session'}
            </Button>
          ) : (
            !active.showsLoading && (
              <p className="m-0 max-w-[22rem] text-[0.85rem] leading-[1.5] text-si-muted">
                {!active.show ? (
                  active.canManageTeam ? (
                    <>
                      {active.team?.name} has no shows yet.{' '}
                      <button type="button" className="underline underline-offset-2 hover:text-si-fg" onClick={() => settingsOpen.set('shows')}>
                        Add one in Settings → Shows
                      </button>{' '}
                      to start logging.
                    </>
                  ) : (
                    `You can't open any show in ${active.team?.name ?? 'this team'} yet. Ask a team owner or admin to grant you a show.`
                  )
                ) : (
                  `You can view ${active.show.name} but not log in it. Ask a team owner or admin for write access.`
                )}
              </p>
            )
          )}
        </div>
      </div>
    </div>
  );
}
