// `/oauth/consent?request=<id>`: an agent (MCP client) asks to act as the signed-in user. Rendered
// outside the app shell, in the gate frame with the login card's wordmark. Approve / Deny posts the
// decision and follows the server's redirect back to the client.

import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { useMe } from '@/api/queries';
import { errorMessage, oauth } from '@/api/rpc';
import { GATE_PAGE, RouteLoadingState } from '@/components/RouteState';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Card } from '@/shared/components/ui/card';
import { Spinner } from '@/shared/components/ui/spinner';

function ConsentCard({ children }: { children: ReactNode }) {
  return (
    <div className={GATE_PAGE}>
      <main className="w-full max-w-[27rem]" aria-labelledby="consent-wordmark">
        <Card className="gap-0 px-7 pt-8 pb-9 text-center animate-overlay-fade-in motion-reduce:animate-none max-md:px-5 max-md:pb-8">
          <h1
            id="consent-wordmark"
            className="m-0 font-league-gothic text-[2.75rem] font-bold uppercase leading-none tracking-[0.02em] text-si-fg max-md:text-[2.4rem]"
          >
            AutoLogger
          </h1>
          {children}
        </Card>
      </main>
    </div>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <ConsentCard>
      <Alert
        variant="destructive"
        className="mt-6 block border-(--si-danger-line) text-left *:data-[slot=alert-description]:text-si-danger"
      >
        <AlertDescription className="m-0 block text-[0.85rem] leading-[1.45]">
          {message}
        </AlertDescription>
      </Alert>
      <p className="mx-auto mt-4 mb-0 max-w-[21rem] text-[0.8rem] leading-[1.5] text-si-muted">
        You can close this tab and start connecting again from your app.
      </p>
    </ConsentCard>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="shrink-0 text-xs font-semibold tracking-wide text-si-dim uppercase">
        {label}
      </dt>
      <dd className="m-0 min-w-0 truncate text-right font-tc text-[0.8rem] text-si-fg">
        {children}
      </dd>
    </div>
  );
}

export function ConsentPage() {
  const me = useMe();
  const requestId = new URLSearchParams(location.search).get('request') ?? '';
  const signedOut = me.data === null;

  useEffect(() => {
    if (signedOut)
      location.replace(`/login?return=${encodeURIComponent(location.pathname + location.search)}`);
  }, [signedOut]);

  const req = useQuery({
    queryKey: ['oauth-request', requestId],
    queryFn: () => oauth.getRequest(requestId),
    enabled: !!me.data && !!requestId,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [deciding, setDeciding] = useState<'approve' | 'deny' | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);

  const decide = async (approve: boolean) => {
    setDeciding(approve ? 'approve' : 'deny');
    setDecideError(null);
    try {
      const { redirectTo } = await oauth.decide(requestId, approve);
      window.location.assign(redirectTo);
    } catch (e) {
      setDecideError(errorMessage(e));
      setDeciding(null);
    }
  };

  if (me.isError) return <Problem message={errorMessage(me.error)} />;
  if (me.isPending || signedOut) return <RouteLoadingState frame="gate" label="Loading" />;
  if (!requestId)
    return (
      <Problem message="This link is missing its authorization request. Start connecting again from your app." />
    );
  if (req.isPending) return <RouteLoadingState frame="gate" label="Loading request" />;
  if (req.isError) return <Problem message={errorMessage(req.error)} />;
  const user = me.data;
  if (!user) return <RouteLoadingState frame="gate" label="Loading" />;

  const { clientName, redirectHost, scope } = req.data;
  const expires = new Date(req.data.expiresAt);

  return (
    <ConsentCard>
      <p className="mx-auto mt-5 mb-0 max-w-[22rem] text-[1.05rem] font-semibold leading-[1.35] text-si-fg">
        {clientName} wants to access AutoLogger as you
      </p>
      <p className="mx-auto mt-3 mb-0 max-w-[22rem] text-[0.875rem] leading-[1.5] text-si-muted">
        It will act as <span className="text-si-fg">{user.name || user.email}</span>, with exactly
        your access: it can read and change the shows and sessions you can.
      </p>

      <dl className="mt-5 mb-0 divide-y divide-si-line rounded-ctl border border-si-line bg-si-bg px-3 text-left">
        <Row label="Returns to">{redirectHost}</Row>
        <Row label="Scope">{scope || '—'}</Row>
        {!Number.isNaN(expires.getTime()) && (
          <Row label="Request expires">
            {expires.toLocaleTimeString(undefined, { timeStyle: 'short' })}
          </Row>
        )}
      </dl>

      <p className="mx-auto mt-4 mb-0 max-w-[22rem] text-[0.8rem] leading-[1.5] text-si-muted">
        Every write it makes is logged under your name and can be undone from the session’s Agents
        tab. You can revoke access any time in Settings › Agents.
      </p>

      {decideError && (
        <Alert
          variant="destructive"
          className="mt-5 block border-(--si-danger-line) text-left *:data-[slot=alert-description]:text-si-danger"
        >
          <AlertDescription className="m-0 block text-[0.85rem] leading-[1.45]">
            {decideError}
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-6 flex flex-col gap-3">
        <Button
          className="h-11 w-full"
          disabled={deciding !== null}
          onClick={() => void decide(true)}
        >
          {deciding === 'approve' && <Spinner role="presentation" aria-hidden="true" />}
          Approve
        </Button>
        <Button
          variant="outline"
          className="h-11 w-full"
          disabled={deciding !== null}
          onClick={() => void decide(false)}
        >
          {deciding === 'deny' && <Spinner role="presentation" aria-hidden="true" />}
          Deny
        </Button>
      </div>
      <p className="mx-auto mt-4 mb-0 text-[0.75rem] text-si-dim">Signed in as {user.email}</p>
    </ConsentCard>
  );
}
