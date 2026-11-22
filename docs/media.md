## Media & worker

Audio lives in S3-compatible object storage; the browser uploads and plays it through presigned
URLs, so audio bytes never pass through the app server. Transcription and YouTube import run in
the **worker** (`apps/server/src/worker/main.ts`), a second entrypoint of the server codebase.

### Environment

| Variable                                                | Used by     | Purpose                                                                                                                                           |
| ------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`                                           | app, worker | Endpoint for server-side S3 calls (`http://s3:8333` in compose). Omit for AWS.                                                                    |
| `S3_PUBLIC_ENDPOINT`                                    | app         | Endpoint browsers reach; presigned PUT/GET URLs are signed against it (e.g. `https://media.example.com`). Defaults to `S3_ENDPOINT`.              |
| `S3_REGION`                                             | app, worker | Default `us-east-1`.                                                                                                                              |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | app, worker | Required for any media feature; without them media ops answer `unavailable`.                                                                      |
| `S3_FORCE_PATH_STYLE`                                   | app, worker | `1` (default) for SeaweedFS/MinIO-style servers; `0` for virtual-hosted AWS buckets.                                                              |
| `DEEPGRAM_API_KEY`                                      | app, worker | Enables transcription (`nova-3`, diarized). Without it uploads still work but are not transcribed and `media.retranscribe` answers `unavailable`. |
| `YOUTUBE_IMPORT`                                        | app         | `1` (default) enables `media.importYoutube`.                                                                                                      |
| `YTDLP_PATH`                                            | worker      | yt-dlp binary (default `yt-dlp` on `PATH`). Best audio is downloaded as-is, ffmpeg is not required.                                               |
| `WORKER_CONCURRENCY`                                    | worker, api | Jobs run in parallel per worker process (default 2). The API uses it for etaSec only while no worker heartbeat row is live.                       |
| `WORKER_CONCURRENCY_TRANSCRIBE`                         | worker      | Of those slots, how many `transcribe` jobs may hold at once (1 to `WORKER_CONCURRENCY`, which is the default).                                    |
| `WORKER_CONCURRENCY_YOUTUBE_IMPORT`                     | worker      | Same for `youtube_import` jobs. Set it below `WORKER_CONCURRENCY` so slow downloads always leave a slot for transcriptions.                       |
| `WORKER_CONCURRENCY_WAVEFORM`                           | worker      | Same for `waveform` jobs (default 1).                                                                                                             |
| `WORKER_CONCURRENCY_COMPILE`                            | worker      | Same for `compile` jobs (video compilations; default 1).                                                                                          |
| `FFMPEG_PATH`                                           | worker      | ffmpeg binary for waveform peaks (default `ffmpeg` on `PATH`; in the worker image). Without it, the worker doesn't claim waveform jobs.           |

The bucket is created on first use (worker start, or the first upload) if the credentials allow it.

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
- Realtime: the worker publishes `audio_segment` / `job` changes and `transcript_segment` /
  `session` invalidations through the bus (Postgres NOTIFY), so open session pages update live.
