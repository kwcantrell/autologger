import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, schema } from '../db/client.ts';
import { env } from '../env.ts';
import { PermanentError } from '../media/deepgram.ts';
import { YoutubeAuthError, youtubeAuthError } from '../media/youtube.ts';
import { handlers } from '../worker/handlers.ts';
import { failJob } from '../worker/queue.ts';
import { call, failsWith, resetDb, setupDb, studio } from './harness.ts';

// YouTube's bot check (#241). yt-dlp is a shell script: it records its arguments and the cookies
// it was given, lists a canned playlist, and otherwise fails like a blocked server (or prints a
// video's metadata when `mode` says ok). Nothing reaches YouTube.
vi.mock('../env.ts', async (orig) => {
  const mod = await orig<typeof import('../env.ts')>();
  return { ...mod, storageConfigured: true, env: { ...mod.env, youtubeEnabled: true } };
});

const BOT =
  "ERROR: [youtube] aaaaaaaaaaa: Sign in to confirm you're not a bot. This helps protect our community. Use --cookies-from-browser or --cookies for the authentication.";
const PLAYLIST = 'https://www.youtube.com/playlist?list=PLbotcheck01';
let dir = '';
const setMode = (m: 'bot' | 'ok') => writeFile(join(dir, 'mode'), m);

beforeAll(async () => {
  await setupDb();
  dir = await mkdtemp(join(tmpdir(), 'fake-yt-dlp-'));
  await writeFile(
    join(dir, 'playlist.json'),
    JSON.stringify({
      title: 'Calculus',
      entries: [{ id: 'aaaaaaaaaaa', title: 'Chapter 1', duration: 600 }],
    }),
  );
  const script = join(dir, 'yt-dlp');
  await writeFile(
    script,
    `#!/bin/sh
printf '%s\\n' "$@" > '${dir}/args.txt'
prev=''
for a in "$@"; do
  if [ "$prev" = --cookies ]; then cp "$a" '${dir}/seen-cookies.txt'; echo '# saved' >> "$a"; fi
  if [ "$a" = --flat-playlist ]; then cat '${dir}/playlist.json'; exit 0; fi
  prev="$a"
done
if [ "$(cat '${dir}/mode')" = ok ]; then echo '{"duration": 600}'; exit 0; fi
echo "${BOT.replace(/"/g, '\\"')}" >&2
exit 1
`,
  );
  await chmod(script, 0o755);
  env.ytDlpPath = script;
});
beforeEach(async () => {
  await resetDb();
  await setMode('bot');
  env.ytDlpCookiesFile = undefined;
  env.ytDlpProxy = undefined;
  env.ytDlpExtraArgs = [];
});

describe('YouTube sign-in errors', () => {
  it('classifies the bot check and restricted videos as permanent', () => {
    const bot = youtubeAuthError(BOT, false);
    expect(bot).toBeInstanceOf(PermanentError);
    expect(bot).toMatchObject({ reason: 'bot_check' });
    expect(bot!.message).toMatch(/^YouTube is blocking this server's downloads \(bot check\)/);
    expect(bot!.message).toContain('YTDLP_COOKIES_FILE');
    expect(youtubeAuthError(BOT, true)!.message).toContain('probably expired');
    expect(
      youtubeAuthError('ERROR: [youtube] x: Sign in to confirm your age. Use --cookies', false),
    ).toMatchObject({ reason: 'restricted' });
    expect(youtubeAuthError('ERROR: [youtube] x: Video unavailable', false)).toBeNull();
  });

  it('fails the import job once, without retries', async () => {
    const { owner, session } = await studio();
    await setMode('ok');
    const job = await call(owner, 'media.importYoutube', {
      sessionId: session.id,
      url: 'https://youtu.be/aaaaaaaaaaa',
    });
    await setMode('bot');
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    const err = await handlers.youtube_import.run({ ...row!, attempts: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(YoutubeAuthError);
    // What the worker loop does with it: permanent → failed now, no retry.
    expect(
      await failJob({ ...row!, attempts: 1 }, err.message, err instanceof PermanentError),
    ).toBe(false);
    const [after] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(after).toMatchObject({ status: 'failed' });
    expect(after!.error).toMatch(/^YouTube is blocking/);
  });

  it('passes a private copy of the cookies, the proxy and extra args to every run', async () => {
    const { owner, session } = await studio();
    const cookies = join(dir, 'cookies.txt');
    const original = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n';
    await writeFile(cookies, original);
    await chmod(cookies, 0o444); // mounted read-only
    env.ytDlpCookiesFile = cookies;
    env.ytDlpProxy = 'socks5://proxy.internal:1080';
    env.ytDlpExtraArgs = ['--extractor-args', 'youtube:player_client=web'];

    const err = await call(owner, 'media.importYoutube', {
      sessionId: session.id,
      url: 'https://youtu.be/aaaaaaaaaaa',
    }).catch((e) => e);
    expect(err.message).toContain('probably expired');

    const args = (await readFile(join(dir, 'args.txt'), 'utf8')).trim().split('\n');
    const copy = args[args.indexOf('--cookies') + 1]!;
    expect(copy).not.toBe(cookies);
    expect(args[args.indexOf('--proxy') + 1]).toBe('socks5://proxy.internal:1080');
    expect(args.slice(args.indexOf('--extractor-args'), -1)).toContain('youtube:player_client=web');
    expect(await readFile(join(dir, 'seen-cookies.txt'), 'utf8')).toBe(original);
    // yt-dlp's write-back went to the copy, which is gone; the original is untouched.
    expect(await readFile(cookies, 'utf8')).toBe(original);
    await expect(access(copy)).rejects.toThrow();
  });
});

describe('import probe', () => {
  it('fails the import without creating sessions or jobs when YouTube blocks downloads', async () => {
    const { owner, show, session } = await studio();
    // The dry run only lists the playlist, which YouTube still allows.
    const preview = await call(owner, 'media.importPlaylist', {
      showId: show.id,
      url: PLAYLIST,
      dryRun: true,
    });
    expect(preview.created).toHaveLength(1);

    await expect(
      call(owner, 'media.importPlaylist', { showId: show.id, url: PLAYLIST }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/bot check.*No sessions were created\.$/),
    });
    await failsWith(
      call(owner, 'media.importYoutube', {
        sessionId: session.id,
        url: 'https://youtu.be/aaaaaaaaaaa',
      }),
      'bad_request',
    );
    expect(await call(owner, 'sessions.list', { showId: show.id })).toHaveLength(1);
    expect(await call(owner, 'jobs.list', { showId: show.id })).toHaveLength(0);
  });
});
