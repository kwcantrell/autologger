## Media & worker

Audio lives in S3-compatible object storage; the browser uploads and plays it through presigned
URLs, so audio bytes never pass through the app server. Transcription and YouTube import run in
the **worker** (`apps/server/src/worker/main.ts`), a second entrypoint of the server codebase.

### Environment

| Variable                                                | Used by     | Purpose                                                                                                                                                                        |
| ------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `S3_ENDPOINT`                                           | app, worker | Endpoint for server-side S3 calls (`http://s3:8333` in compose). Omit for AWS.                                                                                                 |
| `S3_PUBLIC_ENDPOINT`                                    | app         | Endpoint browsers reach; presigned PUT/GET URLs are signed against it (e.g. `https://media.example.com`). Defaults to `S3_ENDPOINT`.                                           |
| `S3_REGION`                                             | app, worker | Default `us-east-1`.                                                                                                                                                           |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | app, worker | Required for any media feature; without them media ops answer `unavailable`.                                                                                                   |
| `S3_FORCE_PATH_STYLE`                                   | app, worker | `1` (default) for SeaweedFS/MinIO-style servers; `0` for virtual-hosted AWS buckets.                                                                                           |
| `DEEPGRAM_API_KEY`                                      | app, worker | Enables transcription (`nova-3`, diarized). Without it uploads still work but are not transcribed and `media.retranscribe` answers `unavailable`.                              |
| `YOUTUBE_IMPORT`                                        | app         | `1` (default) enables `media.importYoutube`.                                                                                                                                   |
| `YTDLP_PATH`                                            | app, worker | yt-dlp binary (default `yt-dlp` on `PATH`). Best audio is downloaded as-is, ffmpeg is not required. The app runs it too, to read playlists and probe a video before importing. |
| `YTDLP_COOKIES_FILE`                                    | app, worker | Netscape `cookies.txt` of a signed-in YouTube session, for servers YouTube bot-checks. Copied per run (may be read-only and shared). See _YouTube bot check_.                  |
| `YTDLP_PROXY`                                           | app, worker | Proxy for every yt-dlp run (`--proxy`, e.g. `socks5://user:pass@host:1080`), for an IP YouTube blocks.                                                                         |
| `YTDLP_JS_RUNTIME`                                      | app, worker | JS runtime yt-dlp solves YouTube's challenges with (`--js-runtimes`). Default: the Node running the server (`node:<path>`); `none` leaves yt-dlp's default (Deno only).                |
| `YTDLP_EXTRA_ARGS`                                      | app, worker | Extra yt-dlp arguments for every run, split on whitespace (no shell, no quoting), e.g. `--extractor-args youtubepot-bgutilhttp:base_url=http://pot:4416`.                      |
| `WORKER_CONCURRENCY`                                    | worker, api | Jobs run in parallel per worker process (default 2). The API uses it for etaSec only while no worker heartbeat row is live.                                                    |
| `WORKER_CONCURRENCY_TRANSCRIBE`                         | worker      | Of those slots, how many `transcribe` jobs may hold at once (1 to `WORKER_CONCURRENCY`, which is the default).                                                                 |
| `WORKER_CONCURRENCY_YOUTUBE_IMPORT`                     | worker      | Same for `youtube_import` jobs. Set it below `WORKER_CONCURRENCY` so slow downloads always leave a slot for transcriptions.                                                    |
| `WORKER_CONCURRENCY_WAVEFORM`                           | worker      | Same for `waveform` jobs (default 1).                                                                                                                                          |
| `WORKER_CONCURRENCY_COMPILE`                            | worker      | Same for `compile` jobs (video compilations; default 1).                                                                                                                       |
| `FFMPEG_PATH`                                           | worker      | ffmpeg binary for waveform peaks (default `ffmpeg` on `PATH`; in the worker image). Without it, the worker doesn't claim waveform jobs.                                        |
| `MEDIA_SWEEP_INTERVAL_MIN`                              | worker      | Minutes between media sweeps (default 60; first run 5 min after start; `0` turns it off). See _media sweep_ below.                                                             |
| `MEDIA_SWEEP_UPLOAD_AGE_HOURS`                          | worker      | Uploads still `uploading` after this long are removed, row and object (default 24, at least 1).                                                                                |
| `MEDIA_SWEEP_ORPHAN_GRACE_HOURS`                        | worker      | Orphaned objects are removed only once the newest under their prefix is this old (default 24, at least 1).                                                                     |
| `MEDIA_SWEEP_LIVE_SESSIONS`                             | worker      | Live sessions per sweep whose objects are checked against their segment rows (default 50, rotating; `0` off).                                                                  |
| `MEDIA_SWEEP_DRY_RUN`                                   | worker      | `1` logs what the sweep would remove and deletes nothing.                                                                                                                      |

The bucket is created on first use (worker start, or the first upload) if the credentials allow it.

### YouTube bot check

YouTube often answers downloads from datacenter IPs with "Sign in to confirm you're not a bot"
(listing a playlist usually still works). yt-dlp then needs cookies from a signed-in session
and/or a proxy. yt-dlp has **no YouTube login**: YouTube blocks its username/password and OAuth
sign-ins, so cookies exported from a browser signed in to YouTube are the only way to sign in.

**Per team (recommended).** A team owner or admin gives the team one YouTube sign-in; every
yt-dlp run for any of its shows (import probe, playlist listing, import and compile jobs) uses
it. It is one per team, not per show, on purpose: every copy of a Google session forks it, and
YouTube invalidates copies that fall behind its cookie rotation.

- **From the command line, one step:** `autologger-import youtube-login --team <teamId>
  --cookies-from-browser firefox` (see [importer.md](importer.md)) reads the browser's YouTube
  cookies with yt-dlp and stores them on the server (`media.setYoutubeCookies`).
- **In the web app:** Settings › Team details › YouTube access: paste or upload a cookies.txt
  (e.g. from the "Get cookies.txt LOCALLY" extension on youtube.com) or a JSON cookie export.
- **Through an agent:** the autologger plugin's import skill checks `media.youtubeAccess`
  before importing, asks the user to sign in and for consent, then sends the cookies with
  `media.setYoutubeCookies`.

Only the youtube.com and google.com cookies are kept, and they must include a signed-in session
(`SID` or `LOGIN_INFO`). Saving tests them at once on a public video and reports whether YouTube
accepted them. Use a **dedicated throwaway Google account**: the cookies grant full access to it,
and YouTube may flag it. YouTube rotates the cookies as they are used, so a browser that keeps
using YouTube in the same profile soon leaves the server's copy behind: export them from a
browser profile used only for this. yt-dlp also rotates them on each server run; the server
stores the refreshed cookies after every run (`team_youtube_cookies`), so a team in regular use
stays signed in longer. The settings card and `media.youtubeAccess` show when they last worked,
and the last error.

The cookies are stored in Postgres in plain text (anyone with database access can read them), are
never returned by any op and are not in the change log.

**Server-wide.** For teams without their own sign-in:

1. Sign in to YouTube in a browser with a dedicated throwaway Google account, ideally in a
   private window you then close without signing out.
2. Export the cookies in Netscape format, e.g. with the "Get cookies.txt LOCALLY" browser
   extension on youtube.com, or `yt-dlp --cookies-from-browser chrome --cookies cookies.txt
   --skip-download https://www.youtube.com/watch?v=jNQXAC9IVRw`.
3. Put the file on the server and mount it read-only into **both** the `app` and `worker`
   containers (the app lists playlists and probes the first video before creating sessions), e.g.
   `./secrets/youtube-cookies.txt:/run/secrets/youtube-cookies.txt:ro`, and set
   `YTDLP_COOKIES_FILE=/run/secrets/youtube-cookies.txt` (see the commented lines in
   `compose.yaml`). Restart both.

yt-dlp rewrites its cookie file on exit, so every run gets its own private copy of the file in a
temp dir (deleted afterwards); the mounted file is never changed and concurrent jobs don't race.
Cookies expire or get signed out (often within weeks): when jobs start failing with "…even with
the team's YouTube sign-in" (or "…the cookies in YTDLP_COOKIES_FILE"): "they have probably
expired", set fresh ones. `YTDLP_PROXY`
(a residential proxy) and `YTDLP_EXTRA_ARGS` (e.g. a PO-token provider plugin's
`--extractor-args`) are alternatives or additions.

A bot check (or a private, members-only or age-restricted video) is a permanent error: the
`youtube_import` or `compile` job fails at once with "YouTube is blocking this server's downloads
(bot check) …" or "YouTube requires a signed-in account …" instead of retrying.
`media.importYoutube` and `media.importPlaylist` (not on `dryRun`) first run a metadata-only
probe of the (first) video with the download's format selection (`--skip-download`, 15 s timeout,
at most 4 at once per app process) and fail with `bad_request`, creating no sessions or jobs,
when it hits that error. Any other probe outcome (yt-dlp missing on the app host, timeout, busy)
lets the import go ahead, so an app host without yt-dlp never blocks imports.

When cookies or a proxy are not an option, or the video or playlist is private, users can run the
**local import helper** on their own computer instead: it downloads with their browser cookies
and uploads only the audio (or a compilation MP4). See [importer.md](importer.md). The bot-check
and sign-in errors above point at it.

### Local S3 for development

`compose.dev.yaml` runs SeaweedFS with its S3 gateway on `localhost:9000` and the credentials from
`.env.example` (`docker compose -f compose.dev.yaml up -d`). Production compose runs the same
image behind Caddy, which serves presigned URLs on the app's own origin (`/autologger/*`), so no
CORS setup is needed. Any S3-compatible service works instead (AWS S3, R2, Garage): point the
`S3_*` variables at it. If the web app and storage are on different origins, the bucket needs a
CORS rule allowing `PUT`/`GET` with the `Content-Type` header from `PUBLIC_URL`.

MinIO is not used: its community container images are no longer published.

### Running the worker

```sh
npm run dev:worker -w apps/server     # watch mode, reads ../../.env
# or
cd apps/server && node --env-file=../../.env src/worker/main.ts
```

Or in Docker, with `yt-dlp` and `ffmpeg` from the image so they need not be installed on the host
(it mounts the repo read-only, so run `npm install` first, and reads `.env` with Postgres and S3
pointed at the compose services):

```sh
docker compose -f compose.dev.yaml --profile worker up -d --build
```

In production: `node src/worker/main.ts` with the same environment as the app (compose service
`worker`). Several workers may run at once.

### How it works

- **Upload** (recording chunks and local files): `media.createUpload` creates an `audio_segments`
  row (`uploading`; `startSec` defaults to the end of the previous segments) and returns a 15-minute
  presigned PUT plus the headers to send. After the PUT, `media.completeUpload` checks the object
  exists, marks the segment `ready`, sets the session's source kind and enqueues `transcribe` and `waveform`.
- **Jobs** live in the `jobs` table. Ops enqueue with `enqueueJob(tx, …)` (`src/media/jobs.ts`)
  inside their transaction, which also sends `NOTIFY autologger_jobs` to wake workers. Workers claim
  with `FOR UPDATE SKIP LOCKED` (skipping kinds whose `WORKER_CONCURRENCY_<KIND>` slots are full in
  that worker, so the next job of another kind runs instead), heartbeat `locked_at` every minute, retry failures up to 3 attempts
  with backoff (30 s, 60 s), and requeue jobs stuck in `running` for more than 15 minutes. Errors
  that cannot succeed on retry (bad Deepgram key, missing yt-dlp) fail immediately.
- **Workers** keep a heartbeat row in `workers` (concurrency, per-kind caps): inserted on start,
  `last_seen_at` bumped every 15 s, deleted on clean shutdown. `jobs.list` / `sessions.get` etaSec
  for queued jobs sums `concurrency` over rows seen in the last 45 s (capped at 256 slots, falling
  back to the API's `WORKER_CONCURRENCY` when none is live) and lets each job ahead take the
  earliest slot freed by a running job. A crashed worker's row simply goes stale.
- **transcribe**: streams the object from S3 to Deepgram, maps utterances to `transcript_segments`
  (speaker `Speaker N`, times offset by the segment's `startSec`) and replaces that segment's previous
  transcript in one transaction. Machine writes are not recorded in the change log.
  Diarization is requested with `diarize_model=latest` (Deepgram's v2 batch diarizer); the
  deprecated `diarize=true` always ran v1, in use when speakers came back merged or swapped in two-person
  interviews (#169). Deepgram takes no speaker-count hint. An utterance whose words change speaker
  becomes one row per speaker run (`speakerRuns`, ≤ 2-word blips under 0.3 s absorbed). Each
  word keeps its speaker in `words[].sp`; transcripts made before that have none, so they can only
  be re-segmented by re-transcribing (`media.retranscribe`). Agents spot likely merged turns with
  `transcript.find` `suspect: true` and split them with `transcript.splitSegment`.
  `src/media/deepgram.live.test.ts` checks this end to end on a synthetic two-speaker clip: word
  speakers change at the turn, rows split there, and `metadata.diarize_info.arch` is not `v1`. It
  runs against a sample response by default and against Deepgram only with `DEEPGRAM_LIVE_TEST=1`
  and `DEEPGRAM_TEST_API_KEY` (`npm run test:deepgram -w @autologger/server`).
- **youtube_import**: yt-dlp downloads the audio to a temp dir, the worker uploads it, creates an
  `origin = 'youtube'` segment at `startSec` 0, sets `sessions.source_kind/source_url` and enqueues
  `transcribe` and `waveform`.
- **waveform**: ffmpeg decodes the segment (read by presigned URL) to 8 kHz mono PCM; one peak
  (max |sample|, one byte) per 50 ms goes to `sessions/<sessionId>/<segmentId>.peaks.json` next to
  the audio, and `audio_segments.peaks_key` points at it. Peak `i` sits at session second
  `startSec + i / 20`. Queued by `media.completeUpload` and `youtube_import`; waveform jobs are
  claimed after every other kind. Read with `media.waveform` (presigned GETs). A worker without
  ffmpeg never claims them (if one does, the job ends done with a "Skipped: ffmpeg not found" note,
  left out of etaSec medians). On start, a worker with ffmpeg queues up to 200 waveform jobs for
  stored segments that have no peaks and no queued, running or failed waveform job (older audio,
  skipped jobs). ffmpeg errors are stored with URLs redacted (they carry presigned signatures).
- **compile** (video compilations, `compilations.*`, payload `{compilationId}`, no session):
  each clip is a range in session seconds of a session imported from YouTube; video second =
  session second − the YouTube audio segment's `startSec`. yt-dlp downloads only that section
  (`--download-sections`, ≤720p, `--force-keyframes-at-cuts`), ffmpeg re-encodes every part to
  1280×720 30 fps H.264 + 48 kHz stereo AAC and concatenates them (`-c copy`, `+faststart`) into
  `shows/<showId>/compilations/<id>.mp4`. Progress ("clip 3/12: downloading") goes to the job and
  the `compilations` row; changes are published as `compilation_changed` on `show:<id>` (show
  socket → the web Compilations page; `compilations.get` waitSec). Needs ffmpeg (and ffprobe for
  the measured length) and yt-dlp; a worker without ffmpeg does not claim compile jobs.
  A compilation created with `buildLocally` gets no compile job: the local import helper builds
  it with the same yt-dlp and ffmpeg settings and uploads the MP4 ([importer.md](importer.md)).
  Clips of audio uploaded from a private video (`source_private`) are refused for server builds.
- **Media sweep** (`src/worker/sweep.ts`, every `MEDIA_SWEEP_INTERVAL_MIN`): removes uploads
  stuck in `uploading` past `MEDIA_SWEEP_UPLOAD_AGE_HOURS` (object, then row; an `audio_segment`
  delete is published), `sessions/<id>/` prefixes whose session no longer exists, `shows/<id>/`
  prefixes whose show no longer exists and, under a live show, `compilations/<id>.mp4` objects
  whose compilation row is gone. Session, show and compilation deletes already remove their objects
  after commit; the sweep catches what that best-effort step missed (crash, S3 outage, a job still
  uploading for a deleted session). Other key shapes under a live show are never touched; orphans
  are removed only when their newest object is older than `MEDIA_SWEEP_ORPHAN_GRACE_HOURS`, so in-flight imports and compiles are left alone. A
  transaction-level advisory lock lets one worker sweep at a time (others skip that round). Every
  removal is logged (`media sweep: removed …`); `MEDIA_SWEEP_DRY_RUN=1` logs `would remove` instead.
  Under a live session, objects that match no `audio_segments.object_key` / `peaks_key` of that
  session (an import that crashed between upload and insert, a failed best-effort delete in
  `media.deleteSegment`, peaks stored for a segment deleted meanwhile) are removed once the object
  itself is older than the grace period. Listing every live session is a full bucket scan, so each
  run checks only `MEDIA_SWEEP_LIVE_SESSIONS` of them, in id order after the last one that worker
  process checked, wrapping around (a restart starts over).
  Each run ends with one summary line, also when nothing was found (`media sweep (dry run): 0 stuck
  uploads, 1 orphan prefix, 0 compilation objects, 0 unreferenced live-session objects would be
  removed; 1 orphan within grace; checked 49 of 49 live sessions; 12 s`),
  and a worker that finds the lock held logs `media sweep: skipped, another worker holds the sweep
  lock`.
- Realtime: the worker publishes `audio_segment` / `job` changes and `transcript_segment` /
  `session` invalidations through the bus (Postgres NOTIFY), so open session pages update live.
