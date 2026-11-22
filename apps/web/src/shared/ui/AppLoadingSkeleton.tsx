import type { ReactNode } from 'react';
import { Card } from '@/shared/components/ui/card';

// AppLoadingSkeleton (nextjs-frontend-migration, task 2.3; design D9.1)
//
// Single-sourced loading placeholder for the Next App Router shell. It is
// rendered as the `loading` fallback of every `ssr: false` client-island
// `dynamic()` import under `web/src/app/**` (see `IndexIsland.tsx`) -- with `ssr: false` on the dynamic import, Next still
// server-renders the `loading` element itself, so the document served for
// every router-known path (design D9.1's "Server-rendered shell") contains
// real layout/skeleton markup instead of an empty mount node.
//
// The SAME component (task 5.1, panel rework 2026-08-13) is also what
// `RootGate` renders for its own in-app loading branch once the island has
// mounted and `useProfile()` is still pending (`web/src/pages/index/
// RootGate.tsx`'s `LoadingState`) -- there is exactly one definition of the
// shared structural frame (wrapper div, role/aria-busy/aria-live/aria-label,
// `data-testid="app-loading-skeleton"`), never two hand-maintained mirrors
// of the loading markup. `RootGate` opts into its richer, client-only
// treatment (the looping brand video) via the `media` prop -- that content
// is a progressive enhancement layered on the one shared frame, not a
// second copy of the frame itself.
//
// Deliberately data-free: no hooks, and the only accepted props (`id`,
// `media`) are caller-supplied static/DOM values, never user- or
// session-derived -- safe to render for any request regardless of
// authentication state or session existence (the shell's no-existence-
// oracle property, `api-contract-freeze` delta).
export function AppLoadingSkeleton({ id, media }: AppLoadingSkeletonProps = {}) {
  return (
    <div
      className="relative z-[1] flex min-h-screen min-h-[100dvh] w-full items-center justify-center px-5 py-10"
      id={id}
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading"
      data-testid="app-loading-skeleton"
    >
      {media ?? (
        // job 088: the shared Card primitive, with the raised glass face, strong edge and card
        // radius this panel had as a hand-rolled div (the overrides replace Card's panel
        // background, hairline border and gap).
        <Card className="relative box-border w-full max-w-[25rem] gap-0 rounded-v5-lg border-v5-border-strong bg-si-panel-2 px-7 py-9 text-center text-v5-text">
          <h1 className="m-0 font-league-gothic font-bold text-[2.25rem] leading-none tracking-[0.02em] uppercase text-v5-text">
            AutoLogger
          </h1>
        </Card>
      )}
    </div>
  );
}

export interface AppLoadingSkeletonProps {
  /** Optional DOM id for callers that need a stable selector (e.g. RootGate's `#root-gate-loading`). */
  id?: string;
  /**
   * Optional progressive-enhancement content rendered in place of the static
   * "AutoLogger" wordmark panel -- e.g. RootGate's looping brand video. Must
   * stay free of user- or session-derived data, same as the default content.
   */
  media?: ReactNode;
}
