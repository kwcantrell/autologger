// Settings › Team details › YouTube access: the team's YouTube sign-in (cookies) that the server's
// yt-dlp uses for imports and compilations of all the team's shows, so YouTube's bot check
// doesn't block them.

import type { Team, YoutubeAccess } from '@autologger/contract';
import { CircleCheckIcon, TriangleAlertIcon, UploadIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { qk, useCapabilities, useOpMutation, useOpQuery } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Card, CardContent } from '@/shared/components/ui/card';
import { FieldDescription, FieldGroup, FieldSeparator } from '@/shared/components/ui/field';
import { Spinner } from '@/shared/components/ui/spinner';
import { Textarea } from '@/shared/components/ui/textarea';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { SettingRow } from '../parts';

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

function statusText(a: YoutubeAccess): string {
  if (!a.configured)
    return a.serverCookies
      ? 'Not set for this team: downloads use the server’s own YouTube cookies.'
      : 'Not set: YouTube may block this server’s downloads (“Sign in to confirm you’re not a bot”).';
  const parts = [`Set ${when(a.updatedAt)}${a.updatedBy?.name ? ` by ${a.updatedBy.name}` : ''}.`];
  if (a.lastOkAt && (!a.lastFailedAt || a.lastOkAt > a.lastFailedAt))
    parts.push(`Last worked ${when(a.lastOkAt)}.`);
  if (a.expiresAt) parts.push(`Expires ${when(a.expiresAt)} at the latest.`);
  return parts.join(' ');
}

export function YoutubeAccessCard({ team }: { team: Team }) {
  const caps = useCapabilities().data;
  const key = [...qk.team(team.id), 'youtubeAccess'];
  const access = useOpQuery(key, 'media.youtubeAccess', { teamId: team.id });
  const set = useOpMutation('media.setYoutubeCookies', { invalidate: () => [key] });
  const { confirm, confirmElement } = useConfirm();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  if (!caps?.youtube || (team.role !== 'owner' && team.role !== 'admin')) return null;
  const a = access.data;
  const failing =
    a?.configured && a.lastFailedAt && (!a.lastOkAt || a.lastFailedAt > a.lastOkAt)
      ? a.lastError
      : null;

  async function save(cookies: string | null) {
    setError(null);
    setCheck(null);
    try {
      const r = await set.mutateAsync({ teamId: team.id, cookies });
      setText('');
      setCheck(r.check);
      showToast(cookies === null ? 'YouTube sign-in removed.' : 'YouTube sign-in saved.');
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Card>
      <CardContent>
        <FieldGroup className="gap-4">
          <SettingRow
            label="YouTube access"
            labelId="settings-team-youtube-label"
            description={
              <>
                YouTube often blocks downloads from servers until someone signs in. yt-dlp can’t
                sign in with a password, so give it the cookies of a browser signed in to YouTube
                (use a spare Google account: the cookies give full access to it). Imports and
                compilations of every show in {team.name} then download as that account, private and
                members-only videos it can watch included. Easiest: run{' '}
                <code className="font-tc">
                  autologger-import youtube-login --team {team.id} --cookies-from-browser firefox
                </code>{' '}
                on your computer, or export youtube.com’s cookies with a cookies.txt browser
                extension and paste or upload them here.
              </>
            }
          />
          {a && (
            <FieldDescription aria-live="polite">
              {access.isLoading ? 'Loading…' : statusText(a)}
            </FieldDescription>
          )}
          {failing && (
            <Alert variant="destructive">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription className="break-words [overflow-wrap:anywhere]">
                YouTube refused these cookies on {when(a!.lastFailedAt)}: set fresh ones.
                <span className="mt-1 block text-xs">{failing}</span>
              </AlertDescription>
            </Alert>
          )}
          {check && (
            <Alert variant={check.ok ? 'default' : 'destructive'}>
              {check.ok ? (
                <CircleCheckIcon aria-hidden="true" />
              ) : (
                <TriangleAlertIcon aria-hidden="true" />
              )}
              <AlertDescription className="break-words [overflow-wrap:anywhere]">
                {check.message}
              </AlertDescription>
            </Alert>
          )}
          <FieldSeparator />
          <Textarea
            aria-labelledby="settings-team-youtube-label"
            rows={4}
            spellCheck={false}
            autoComplete="off"
            className="font-tc text-xs"
            placeholder={'# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t…'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {error && (
            <Alert variant="destructive">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription className="break-words [overflow-wrap:anywhere]">
                {error}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <input
              ref={file}
              type="file"
              accept=".txt,.json,text/plain,application/json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) setText(await f.text());
              }}
            />
            {a?.configured && (
              <Button
                variant="ghost"
                disabled={set.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Remove YouTube sign-in',
                    message: `Remove the YouTube sign-in of ${team.name}? Imports and compilations of its shows may then be blocked by YouTube until someone sets new cookies. This can't be undone.`,
                    confirmLabel: 'Remove',
                    danger: true,
                  });
                  if (ok) await save(null);
                }}
              >
                Remove
              </Button>
            )}
            <Button
              variant="outline"
              disabled={set.isPending}
              onClick={() => file.current?.click()}
            >
              <UploadIcon data-icon="inline-start" aria-hidden="true" />
              Choose file
            </Button>
            <Button disabled={!text.trim() || set.isPending} onClick={() => void save(text)}>
              {set.isPending && <Spinner data-icon="inline-start" aria-hidden="true" />}
              {set.isPending ? 'Checking…' : a?.configured ? 'Replace cookies' : 'Save cookies'}
            </Button>
          </div>
        </FieldGroup>
      </CardContent>
      {confirmElement}
    </Card>
  );
}
