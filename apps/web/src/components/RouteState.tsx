import type { HTMLAttributes, ReactNode } from 'react';
import { Empty } from '@/shared/components/ui/empty';
import { cn } from '@/shared/lib/utils';
import { AUTOLOGGER_LOADING_VIDEO_SRC } from '@/shared/utils/loadingVideo';

/** The route frame under the top bar (every route state renders inside it). */
export const ROUTE_STATE_PAGE =
  'relative z-[1] flex w-full items-center justify-center px-5 py-16 min-h-[calc(100dvh-var(--topbar-h)-2.2rem)] max-md:min-h-0';
/** Full-viewport frame for states shown before the shell exists. */
export const GATE_PAGE =
  'relative z-[1] flex min-h-screen min-h-[100dvh] w-full items-center justify-center px-5 py-10';

export const PANEL =
  'relative box-border w-full max-w-[25rem] gap-0 rounded-card border border-(--si-line-strong) bg-si-panel-2 px-7 py-9 text-center text-si-fg';
const TITLE =
  'm-0 font-league-gothic font-bold text-[2.25rem] leading-none tracking-[0.02em] uppercase text-si-fg';
const COPY = 'mx-auto mb-0 mt-3 max-w-[19rem] text-[0.9rem] leading-[1.5] text-si-muted';
const BADGE = 'm-0 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-si-muted';

export const LOADING_VIDEO_MEDIA =
  'autologger-loading-video__media pointer-events-none block h-12 w-auto max-w-[min(40vw,12rem)] object-contain';

export function LoadingVideo({ className }: { className?: string }) {
  return (
    <video
      className={cn(LOADING_VIDEO_MEDIA, className)}
      src={AUTOLOGGER_LOADING_VIDEO_SRC}
      preload="auto"
      muted
      playsInline
      autoPlay
      loop
    />
  );
}

interface RouteStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'role'> {
  frame: 'route' | 'gate';
  role: 'status' | 'alert';
  title: ReactNode;
  badge?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}

/** Full-page state panel: not found, archived, errors, denied. */
export function RouteState({
  frame,
  role,
  title,
  badge,
  children,
  actions,
  className,
  ...rest
}: RouteStateProps) {
  return (
    <div className={frame === 'route' ? ROUTE_STATE_PAGE : GATE_PAGE}>
      <Empty role={role} className={cn(PANEL, className)} {...rest}>
        {badge !== undefined && <p className={BADGE}>{badge}</p>}
        <h1 data-slot="empty-title" className={cn(TITLE, badge !== undefined && 'mt-2')}>
          {title}
        </h1>
        {children !== undefined && <div className={COPY}>{children}</div>}
        {actions !== undefined && <div className="mt-6 flex w-full flex-col gap-3">{actions}</div>}
      </Empty>
    </div>
  );
}

export function RouteLoadingState({
  label = 'Loading',
  frame = 'route',
}: {
  label?: string;
  frame?: 'route' | 'gate';
}) {
  return (
    <output
      className={frame === 'route' ? ROUTE_STATE_PAGE : GATE_PAGE}
      aria-busy="true"
      aria-live="polite"
      aria-label={label}
    >
      <div className="m-0 flex min-h-10 items-center justify-center p-0">
        <LoadingVideo />
      </div>
    </output>
  );
}

/** Scrollable page frame shared by search, wiki and other full-width routes. */
export function PageFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="md:absolute md:inset-0 md:overflow-y-auto">
      <div className={cn('mx-auto flex max-w-[52rem] flex-col gap-5 px-4 py-6', className)}>
        {children}
      </div>
    </div>
  );
}
