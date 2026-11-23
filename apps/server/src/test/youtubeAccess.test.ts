import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, schema } from '../db/client.ts';
import { env } from '../env.ts';
import { PermanentError } from '../media/deepgram.ts';
import { YoutubeAuthError, youtubeAuthError } from '../media/youtube.ts';
import { parseYoutubeCookies } from '../media/youtubeCookies.ts';
import { handlers } from '../worker/handlers.ts';
import { failJob } from '../worker/queue.ts';
import { call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

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
  if [ "$prev" = --cookies ]; then cp "$a" '${dir}/seen-cookies.txt'; printf '.youtube.com\tTRUE\t/\tTRUE\t0\tROTATED\t%s\n' "$$" >> "$a"; fi
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
    const bot = youtubeAuthError(BOT, null);
    expect(bot).toBeInstanceOf(PermanentError);
    expect(bot).toMatchObject({ reason: 'bot_check' });
    expect(bot!.message).toMatch(/^YouTube is blocking this server's downloads \(bot check\)/);
    expect(bot!.message).toContain('YTDLP_COOKIES_FILE');
    expect(youtubeAuthError(BOT, 'server')!.message).toContain('probably expired');
    expect(
      youtubeAuthError('ERROR: [youtube] x: Sign in to confirm your age. Use --cookies', null),
    ).toMatchObject({ reason: 'restricted' });
    expect(youtubeAuthError('ERROR: [youtube] x: Video unavailable', null)).toBeNull();
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

const SIGNED_IN = [
  '# Netscape HTTP Cookie File',
  '.youtube.com\tTRUE\t/\tTRUE\t4102444800\tLOGIN_INFO\tlogin',
  '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t4102444800\t__Secure-3PSID\tsid',
  '.google.com\tTRUE\t/\tTRUE\t4102444800\tSID\tgsid',
  '.example.com\tTRUE\t/\tFALSE\t0\tother\tsecret',
].join('\n');

describe('team YouTube sign-in', () => {
  it('keeps only signed-in YouTube and Google cookies, from cookies.txt or JSON', () => {
    const p = parseYoutubeCookies(SIGNED_IN);
    expect(p.count).toBe(3);
    expect(p.text).not.toContain('example.com');
    expect(p.text).toContain('#HttpOnly_.youtube.com\tTRUE');
    expect(p.expiresAt?.toISOString()).toBe('2100-01-01T00:00:00.000Z');
    const json = parseYoutubeCookies(
      JSON.stringify([
        { domain: '.youtube.com', name: 'SID', value: 'x', path: '/', secure: true },
      ]),
    );
    expect(json.text).toContain('.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx');
    expect(() =>
      parseYoutubeCookies('.youtube.com\tTRUE\t/\tTRUE\t0\tVISITOR_INFO1_LIVE\tv'),
    ).toThrow(/not from a signed-in/);
    expect(() => parseYoutubeCookies('hello')).toThrow(/not a cookie export/);
  });

  it("stores, tests, uses and refreshes the team's cookies for all its shows", async () => {
    const { owner, team, show } = await studio();
    // A second show of the team uses the sign-in set through the first one.
    const other = await call(owner, 'shows.create', { teamId: team.id, name: 'Other' });
    const session = await call(owner, 'sessions.create', { showId: other.id });
    const stranger = await makeUser('stranger@example.com');
    await failsWith(
      call(stranger, 'media.setYoutubeCookies', { showId: show.id, cookies: SIGNED_IN }),
      'not_found',
    );
    await failsWith(
      call(owner, 'media.setYoutubeCookies', { showId: show.id, cookies: 'nope' }),
      'bad_request',
    );

    // The check reads a public video with them; YouTube refuses here, they are saved anyway.
    const set = await call(owner, 'media.setYoutubeCookies', {
      showId: show.id,
      cookies: SIGNED_IN,
    });
    expect(set).toMatchObject({
      configured: true,
      check: { ok: false },
      lastError: expect.any(String),
    });
    expect(JSON.stringify(set)).not.toContain('gsid');

    // Imports of the show run yt-dlp with them, and the error names the show setting.
    const err = await call(owner, 'media.importYoutube', {
      sessionId: session.id,
      url: 'https://youtu.be/aaaaaaaaaaa',
    }).catch((e) => e);
    expect(err.message).toMatch(/even with the team’s YouTube sign-in/);
    expect(await readFile(join(dir, 'seen-cookies.txt'), 'utf8')).toContain('\tLOGIN_INFO\tlogin');

    // A successful run records it and stores yt-dlp's rotated cookies.
    await setMode('ok');
    const job = await call(owner, 'media.importYoutube', {
      sessionId: session.id,
      url: 'https://youtu.be/aaaaaaaaaaa',
      transcribe: false,
    });
    const [jobRow] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(jobRow!.payload).toMatchObject({ transcribe: false });
    const [row] = await db
      .select()
      .from(schema.teamYoutubeCookies)
      .where(eq(schema.teamYoutubeCookies.teamId, team.id));
    expect(row!.cookies).toContain('\tROTATED\t');
    expect(row!.lastOkAt).not.toBeNull();
    expect(await call(owner, 'media.youtubeAccess', { showId: show.id })).toMatchObject({
      teamId: team.id,
      configured: true,
      lastError: null,
    });

    await call(owner, 'media.setYoutubeCookies', { teamId: team.id, cookies: null });
    expect(await call(owner, 'media.youtubeAccess', { teamId: team.id })).toMatchObject({
      configured: false,
    });
  });
});
