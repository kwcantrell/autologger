import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Redirect } from 'wouter';
import { qk, useMe } from '@/api/queries';
import { auth } from '@/api/rpc';
import { GATE_PAGE, LoadingVideo, PANEL, RouteState } from '@/components/RouteState';
import { Button } from '@/shared/components/ui/button';
import { Card } from '@/shared/components/ui/card';
import { AppShell } from './AppShell';
import { Onboarding } from './Onboarding';

export function currentPath() {
  return `${location.pathname}${location.search}`;
}

export function RootGate() {
  const me = useMe();
  const qc = useQueryClient();

  if (me.isPending) {
    return (
      <div className={GATE_PAGE} role="status" aria-busy="true" aria-label="Loading">
        <LoadingVideo />
      </div>
    );
  }
  if (me.isError) {
    return (
      <RouteState
        frame="gate"
        role="alert"
        title="AutoLogger"
        actions={
          <Button
            className="h-11 w-full"
            disabled={me.isFetching}
            onClick={() => void me.refetch()}
          >
            {me.isFetching ? 'Retrying…' : 'Try again'}
          </Button>
        }
      >
        Couldn't reach the server. Check your connection and try again.
      </RouteState>
    );
  }
  if (!me.data)
    return <Redirect to={`/login?return=${encodeURIComponent(currentPath())}`} replace />;

  if (me.data.status === 'pending') {
    return (
      <PendingApproval
        email={me.data.email}
        onRefresh={() => void me.refetch()}
        onSignOut={async () => {
          await auth.logout().catch(() => null);
          qc.setQueryData(qk.me, null);
        }}
        refreshing={me.isFetching}
      />
    );
  }
  if (me.data.teams.length === 0) return <Onboarding />;
  return <AppShell />;
}

function PendingApproval({
  email,
  onRefresh,
  onSignOut,
  refreshing,
}: {
  email: string;
  onRefresh: () => void;
  onSignOut: () => void;
  refreshing: boolean;
}) {
  // Check again every 30s so the page opens itself once approved.
  useEffect(() => {
    const t = setInterval(onRefresh, 30_000);
    return () => clearInterval(t);
  }, [onRefresh]);
  return (
    <div className={GATE_PAGE}>
      <Card className={PANEL} role="status">
        <p className="m-0 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-si-muted">
          Waiting for approval
        </p>
        <h1 className="m-0 mt-2 font-league-gothic text-[2.25rem] font-bold uppercase leading-none tracking-[0.02em]">
          AutoLogger
        </h1>
        <p className="mx-auto mt-3 mb-0 max-w-[20rem] text-[0.9rem] leading-[1.5] text-si-muted">
          You're signed in as <span className="text-si-fg">{email}</span>. An administrator of this
          AutoLogger server has to approve new accounts before they can open shows. You'll get in as
          soon as they do; joining a team you were invited to approves you automatically.
        </p>
        <div className="mt-6 flex w-full flex-col gap-3">
          <Button className="h-11 w-full" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? 'Checking…' : 'Check again'}
          </Button>
          <Button variant="outline" className="h-11 w-full" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </Card>
    </div>
  );
}
