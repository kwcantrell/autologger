import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, Redirect } from 'wouter';
import { qk, useCapabilities, useMe } from '@/api/queries';
import { auth, errorMessage } from '@/api/rpc';
import { GATE_PAGE } from '@/components/RouteState';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Card } from '@/shared/components/ui/card';
import { Input } from '@/shared/components/ui/input';
import { Separator } from '@/shared/components/ui/separator';
import { Spinner } from '@/shared/components/ui/spinner';

const LOGIN_ERRORS: Record<string, string> = {
  state: 'This sign-in attempt expired.',
  google: 'Sign-in was cancelled or refused.',
  email: "Google didn't share a verified email address for this account.",
  disabled: 'This account is disabled. Ask an administrator of this server to re-enable it.',
};

/** Only same-site relative paths are allowed as post-login destinations. */
export function safeReturn(path: string | null | undefined): string {
  if (!path?.startsWith('/') || path.startsWith('//') || path.startsWith('/login')) return '/';
  return path;
}

const MARK = 'relative mx-auto mb-6 h-12 w-64 max-w-full select-none pointer-events-none';
const MARK_DOT = 'absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-si-dim';

function BrandMark() {
  return (
    <div className={MARK} aria-hidden="true">
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full border border-si-line bg-si-panel-2" />
      <span className={`${MARK_DOT} left-[12%]`} />
      <span className="absolute top-1/2 left-[34%] h-2 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-si-accent" />
      <span className={`${MARK_DOT} left-[64%]`} />
      <span className={`${MARK_DOT} left-[86%]`} />
      <span className="absolute inset-y-0 left-[46%] w-0.5 -translate-x-1/2 rounded-full bg-si-accent [box-shadow:0_0_10px_1px_color-mix(in_oklab,var(--si-accent)_75%,transparent),0_0_4px_1px_color-mix(in_oklab,var(--si-accent)_75%,transparent)]" />
    </div>
  );
}

const BTN_GOOGLE =
  'mt-7 box-border flex h-12 w-full cursor-pointer items-center justify-center gap-[0.65rem] rounded-ctl border border-[#747775] bg-white px-4 text-[0.9rem] font-medium leading-[1.2] text-[#1f1f1f] no-underline shadow-[0_1px_2px_rgba(0,0,0,0.12)] [font-family:"Roboto",ui-sans-serif,system-ui,-apple-system,"Segoe_UI",sans-serif] [transition:background_0.15s_ease,border-color_0.15s_ease,box-shadow_0.15s_ease] hover-always:border-[#5f6368] hover-always:bg-[#f8f9fa] hover-always:shadow-[0_1px_3px_rgba(0,0,0,0.16)]';
const BTN_CREATE =
  'mt-4 box-border flex h-11 w-full items-center justify-center rounded-ctl border border-(--si-line-strong) bg-[rgba(255,255,255,0.03)] px-4 text-[0.8125rem] font-semibold tracking-[0.04em] text-[rgba(229,238,252,0.78)] hover-always:bg-[rgba(255,255,255,0.05)] hover-always:text-si-fg';

function GoogleGMark() {
  return (
    <svg className="block shrink-0" width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6C44.98 37.03 48 31.06 48 24c0-1.67-.14-3.29-.41-4.84z"
      />
      <path
        fill="#FBBC05"
        d="M6.99 29.16c-.65-1.95-1-4.02-1-6.16 0-2.15.35-4.22 1-6.16l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.35L6.99 29.16z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.35 0-11.72-4.27-13.59-10.08l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export function LoginPage() {
  const params = new URLSearchParams(location.search);
  const returnTo = safeReturn(params.get('return'));
  const errorCode = params.get('error');
  const caps = useCapabilities();
  const me = useMe();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [devError, setDevError] = useState<string | null>(null);

  if (me.data) return <Redirect to={returnTo} replace />;

  const onDevLogin = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setDevError(null);
    try {
      await auth.devLogin(email.trim(), name.trim() || undefined);
      await qc.invalidateQueries({ queryKey: qk.me });
      // Full navigation: the deep link (e.g. /oauth/consent) re-reads its state from the server.
      location.assign(returnTo);
    } catch (err) {
      setDevError(errorMessage(err));
      setBusy(false);
    }
  };

  const googleHref = auth.googleStartUrl(returnTo);
  const c = caps.data;

  return (
    <div className={GATE_PAGE}>
      <main className="w-full max-w-[25rem]" aria-labelledby="login-wordmark">
        <Card className="gap-0 px-7 pt-8 pb-9 text-center animate-overlay-fade-in motion-reduce:animate-none max-md:px-5 max-md:pb-8">
          <BrandMark />
          <h1
            id="login-wordmark"
            className="m-0 font-league-gothic text-[2.75rem] font-bold uppercase leading-none tracking-[0.02em] text-si-fg max-md:text-[2.4rem]"
          >
            AutoLogger
          </h1>
          <p className="mx-auto mt-2 mb-0 max-w-[19rem] text-[0.9rem] leading-[1.5] text-si-muted">
            Sign in to open your sessions, markers, and transcripts.
          </p>

          {errorCode && (
            <Alert
              variant="destructive"
              className="mt-6 block border-(--si-danger-line) text-left *:data-[slot=alert-description]:text-si-danger"
            >
              <AlertDescription className="m-0 block text-[0.85rem] leading-[1.45]">
                {LOGIN_ERRORS[errorCode] ?? "Sign-in didn't complete."}
              </AlertDescription>
            </Alert>
          )}

          {caps.isPending && (
            <div className="mt-7 flex justify-center text-si-muted">
              <Spinner />
            </div>
          )}
          {caps.isError && (
            <Alert variant="destructive" className="mt-6 text-left">
              <AlertDescription>
                Couldn't reach the server to see how sign-in works here. {errorMessage(caps.error)}
              </AlertDescription>
            </Alert>
          )}

          {c?.googleAuth && (
            <>
              <a className={BTN_GOOGLE} href={googleHref} id="login-btn-google">
                <GoogleGMark />
                <span>Sign in with Google</span>
              </a>
              <div className="mt-6 flex items-center gap-3" aria-hidden="true">
                <Separator className="flex-1 bg-si-line" />
                <span className="whitespace-nowrap text-[0.625rem] font-semibold uppercase tracking-[0.18em] text-si-muted">
                  New to AutoLogger?
                </span>
                <Separator className="flex-1 bg-si-line" />
              </div>
              <a className={BTN_CREATE} href={googleHref}>
                Create an account with Google
              </a>
              <p className="mx-auto mt-4 mb-0 max-w-[20rem] text-[0.78rem] leading-[1.5] text-si-dim">
                Your account is created automatically the first time you sign in with Google. New
                accounts wait for an administrator's approval unless you were invited to a team.
              </p>
            </>
          )}

          {c?.devLogin && (
            <form
              onSubmit={onDevLogin}
              className="mt-7 flex flex-col gap-2 text-left"
              aria-label="Development sign-in"
            >
              {c.googleAuth && <Separator className="mb-4 bg-si-line" />}
              <p className="m-0 text-[0.625rem] font-semibold uppercase tracking-[0.18em] text-si-muted">
                Development sign-in
              </p>
              <Input
                type="email"
                required
                placeholder="you@example.com"
                aria-label="Email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Input
                placeholder="Name (optional)"
                aria-label="Name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              {devError && <p className="m-0 text-[0.85rem] text-si-danger">{devError}</p>}
              <Button type="submit" className="mt-1 h-11" disabled={busy || !email.trim()}>
                {busy && <Spinner />}
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
              <p className="m-0 text-[0.78rem] leading-[1.5] text-si-dim">
                This server has DEV_LOGIN on: anyone can sign in as any email. Never enable it in
                production.
              </p>
            </form>
          )}

          {c && !c.googleAuth && !c.devLogin && (
            <Alert className="mt-6 text-left">
              <AlertDescription>
                No sign-in method is configured on this server. Set GOOGLE_CLIENT_ID and
                GOOGLE_CLIENT_SECRET (or DEV_LOGIN=1 for local development) and restart it.
              </AlertDescription>
            </Alert>
          )}
        </Card>
        <p className="mt-5 mb-0 text-center text-[0.8125rem]">
          <Link
            href="/"
            className="text-si-muted no-underline outline-none hover:text-si-fg hover:underline focus-visible:rounded-ctl focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            What is AutoLogger?
          </Link>
        </p>
      </main>
    </div>
  );
}
