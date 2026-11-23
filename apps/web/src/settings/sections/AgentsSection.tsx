import type { ApiToken } from '@autologger/contract';
import { BotIcon, DownloadIcon } from 'lucide-react';
import { type FormEvent, Fragment, useState } from 'react';
import { qk, useCapabilities, useOpMutation, useTokens } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { DocsLink } from '@/components/DocsLink';
import { DOC_PAGES } from '@/lib/docsLinks';
import { CopyRow } from '@/session/tabs/CopyRow';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from '@/shared/components/ui/item';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select';
import { Spinner } from '@/shared/components/ui/spinner';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { IMPORT_HELPER_ANCHOR } from '../openSettingsAt';
import {
  CopyField,
  copyText,
  EmptyState,
  ErrorAlert,
  ErrorState,
  fmtDate,
  LoadingState,
  SettingRow,
  SettingsSectionHeader,
  TokenDialog,
} from '../parts';

const EXPIRY = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];

export function AgentsSection() {
  const caps = useCapabilities();
  const tokens = useTokens();
  const createPat = useOpMutation('tokens.createPat', { invalidate: () => [qk.tokens] });
  const revoke = useOpMutation('tokens.revoke', { invalidate: () => [qk.tokens] });
  const { confirm, confirmElement } = useConfirm();
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('90');
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const publicUrl = (caps.data?.publicUrl ?? location.origin).replace(/\/$/, '');
  const mcpUrl = `${publicUrl}/mcp`;
  const command = `claude mcp add --transport http autologger ${mcpUrl}`;

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    try {
      const res = await createPat.mutateAsync({
        name: name.trim(),
        ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) }),
      });
      setToken(res.token);
      setName('');
    } catch (err) {
      setError(`Couldn’t create the token: ${errorMessage(err)}`);
    }
  }

  async function handleRevoke(t: ApiToken) {
    const label = t.kind === 'oauth' ? (t.clientName ?? t.name) : t.name;
    const ok = await confirm({
      title: t.kind === 'oauth' ? 'Disconnect app' : 'Revoke token',
      message:
        t.kind === 'oauth'
          ? `Disconnect ${label}? It loses access at once, and has to be connected again to use your sessions.`
          : `Revoke ${label}? Any agent using it stops working at once.`,
      confirmLabel: t.kind === 'oauth' ? 'Disconnect' : 'Revoke',
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await revoke.mutateAsync({ tokenId: t.id });
      showToast(t.kind === 'oauth' ? `${label} disconnected.` : `${label} revoked.`);
    } catch (err) {
      setError(`Couldn’t revoke ${label}: ${errorMessage(err)}`);
    }
  }

  const list = tokens.data ?? [];

  return (
    <>
      <SettingsSectionHeader
        title="Agents"
        description="AI agents connected over MCP act as you. Every change they make shows in the session’s Agents tab and can be undone."
      />

      <Card>
        <CardHeader>
          <CardTitle>Connect an agent</CardTitle>
          <CardDescription>
            Agents get the same access you have: they can read and log in every show you can open,
            and nothing more. Step by step:{' '}
            <DocsLink page={DOC_PAGES.connectingAgents}>Connecting agents</DocsLink>; for client
            authors: <DocsLink page={DOC_PAGES.mcpServer}>MCP server</DocsLink>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel>MCP server URL</FieldLabel>
              <CopyField value={mcpUrl} label="MCP server URL" what="URL" />
              <FieldDescription>
                In claude.ai or Claude Desktop, add a custom connector with this URL and sign in
                when asked (OAuth). Other clients can send a personal access token as a Bearer token
                instead.
              </FieldDescription>
            </Field>
            <FieldSeparator />
            <Field>
              <FieldLabel>Claude Code</FieldLabel>
              <CopyField value={command} label="Claude Code command" what="Command" />
              <FieldDescription>
                Run this in a terminal, then run /mcp inside Claude Code to sign in.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>New personal access token</CardTitle>
          <CardDescription>
            For agents and scripts that can’t sign in themselves. Treat it like a password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void create(e)}>
            <FieldGroup className="gap-4">
              <SettingRow
                label="Name"
                htmlFor="settings-pat-name"
                description="What uses it, so you can tell tokens apart later."
              >
                <Input
                  id="settings-pat-name"
                  maxLength={200}
                  placeholder="e.g. Logging script"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </SettingRow>
              <FieldSeparator />
              <SettingRow
                label="Expires"
                labelId="settings-pat-expiry-label"
                description="After this, the token stops working."
              >
                <Select items={EXPIRY} value={expiry} onValueChange={(v) => v && setExpiry(v)}>
                  <SelectTrigger
                    aria-labelledby="settings-pat-expiry-label"
                    className="min-w-0 flex-1"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY.map((it) => (
                      <SelectItem key={it.value} value={it.value}>
                        {it.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="submit" disabled={!name.trim() || createPat.isPending}>
                  {createPat.isPending && <Spinner data-icon="inline-start" aria-hidden="true" />}
                  Create token
                </Button>
              </SettingRow>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {/* Above the token list, so its loading doesn't move this card under a deep link. */}
      <ImportHelperCard />

      <Card>
        <CardHeader>
          <CardTitle>Connected agents and tokens</CardTitle>
          <CardDescription>Revoking one ends its access at once.</CardDescription>
        </CardHeader>
        <CardContent>
          {tokens.isError ? (
            <ErrorState
              title="Couldn’t load your tokens."
              detail={errorMessage(tokens.error)}
              onRetry={() => void tokens.refetch()}
            />
          ) : tokens.isPending ? (
            <LoadingState label="Loading your tokens…" />
          ) : list.length === 0 ? (
            <EmptyState
              icon={<BotIcon aria-hidden="true" />}
              title="No agents connected"
              description="Connect one with the URL above, or create a personal access token."
            />
          ) : (
            <ItemGroup role="list" aria-label="Agent tokens">
              {list.map((t, i) => (
                <Fragment key={t.id}>
                  {i > 0 && <ItemSeparator />}
                  <TokenRow
                    token={t}
                    revoking={revoke.isPending && revoke.variables?.tokenId === t.id}
                    onRevoke={() => void handleRevoke(t)}
                  />
                </Fragment>
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>

      <TokenDialog
        token={token}
        title="Personal access token"
        description="Use it as a Bearer token: Authorization: Bearer <token>."
        onClose={() => setToken(null)}
      />
      {confirmElement}
    </>
  );
}

/** Served by the API without sign-in (docs/developers/import-helper.md). */
const IMPORTER_PATH = '/api/importer/autologger-import.mjs';

/** The local import helper: download, configuration and example commands (docs/developers/import-helper.md). */
function ImportHelperCard() {
  const { show } = useActive();
  const origin = location.origin;
  const download = `${origin}${IMPORTER_PATH}`;
  const showId = show?.id ?? '<showId>';
  const run = 'node autologger-import.mjs';
  const copy = (value: string) => void copyText(value, 'Command');
  return (
    <Card
      id={IMPORT_HELPER_ANCHOR}
      tabIndex={-1}
      role="region"
      aria-labelledby="settings-import-helper-title"
      className="scroll-mt-4 outline-none"
    >
      <CardHeader>
        <CardTitle id="settings-import-helper-title">Import from your computer</CardTitle>
        <CardDescription>
          When YouTube blocks the server’s downloads and the team’s YouTube sign-in (Settings › Team
          details) doesn’t help, or for a private playlist, the AutoLogger import helper runs yt-dlp
          on your computer with your browser’s YouTube sign-in and uploads only the audio. It also
          builds compilations made to be built locally. Needs Node.js 22 or newer and yt-dlp (and
          ffmpeg for compilations). All commands and options:{' '}
          <DocsLink page={DOC_PAGES.importHelper}>Import helper</DocsLink>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-4">
          <Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                nativeButton={false}
                render={<a href={download} download="autologger-import.mjs" />}
              >
                <DownloadIcon data-icon="inline-start" aria-hidden="true" />
                Download autologger-import.mjs
              </Button>
            </div>
            <CopyRow
              label="Or download in a terminal"
              value={`curl -fLO ${download}`}
              onCopy={copy}
            />
          </Field>
          <FieldSeparator />
          <Field>
            <CopyRow
              label="AUTOLOGGER_URL"
              value={`export AUTOLOGGER_URL=${origin}`}
              onCopy={copy}
            />
            <CopyRow
              label="AUTOLOGGER_TOKEN"
              value="export AUTOLOGGER_TOKEN=<token>"
              onCopy={copy}
            />
            <FieldDescription>
              Replace &lt;token&gt; with a personal access token created above.
            </FieldDescription>
          </Field>
          <FieldSeparator />
          <Field>
            <CopyRow
              label="Import a playlist"
              value={`${run} playlist '<playlist-url>' --show ${showId} --cookies-from-browser chrome`}
              onCopy={copy}
            />
            <CopyRow
              label="Import one video"
              value={`${run} video '<video-url>' --show ${showId} --cookies-from-browser chrome`}
              onCopy={copy}
            />
            <CopyRow
              label="Build a compilation"
              value={`${run} compile <compilationId> --cookies-from-browser chrome`}
              onCopy={copy}
            />
            <FieldDescription>
              {show && (
                <>
                  <code className="font-tc">--show</code> is {show.name}.{' '}
                </>
              )}
              <code className="font-tc">--cookies-from-browser</code> names the browser you’re
              signed in to YouTube with (chrome, firefox, edge, safari…). The Compilations page
              shows the compile command of each compilation waiting for a local build. Re-running a
              command resumes it.
            </FieldDescription>
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

function TokenRow({
  token: t,
  revoking,
  onRevoke,
}: {
  token: ApiToken;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const label = t.kind === 'oauth' ? (t.clientName ?? t.name) : t.name;
  const parts = [
    `Created ${fmtDate(t.createdAt)}`,
    `Last used ${fmtDate(t.lastUsedAt)}`,
    t.expiresAt ? `Expires ${fmtDate(t.expiresAt)}` : 'Never expires',
  ];
  return (
    <Item role="listitem" size="sm" className="flex-nowrap">
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full min-w-0">
          <span className="min-w-0 truncate">{label}</span>
          <Badge variant={t.kind === 'oauth' ? 'secondary' : 'outline'}>
            {t.kind === 'oauth' ? 'Connected app' : 'Token'}
          </Badge>
        </ItemTitle>
        <ItemDescription className="truncate">
          {t.kind === 'pat' && <span className="font-tc">{`${t.prefix}… · `}</span>}
          {parts.join(' · ')}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        <Button
          variant="ghost"
          size="sm"
          disabled={revoking}
          aria-label={`Revoke ${label}`}
          onClick={onRevoke}
        >
          {revoking && <Spinner data-icon="inline-start" aria-hidden="true" />}
          {t.kind === 'oauth' ? 'Disconnect' : 'Revoke'}
        </Button>
      </ItemActions>
    </Item>
  );
}
