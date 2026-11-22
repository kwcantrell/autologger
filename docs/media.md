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
| `WORKER_CONCURRENCY`                                    | worker      | Jobs run in parallel per worker process (default 2).                                                                                              |

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

In production: `node src/worker/main.ts` with the same environment as the app (compose service
`worker`). Several workers may run at once.

### How it works

- **Upload** (recording chunks and local files): `media.createUpload` creates an `audio_segments`
  row (`uploading`; `startSec` defaults to the end of the previous segments) and returns a 15-minute
  presigned PUT plus the headers to send. After the PUT, `media.completeUpload` checks the object
  exists, marks the segment `ready`, sets the session's source kind and enqueues `transcribe`.
- **Jobs** live in the `jobs` table. Ops enqueue with `enqueueJob(tx, …)` (`src/media/jobs.ts`)
  inside their transaction, which also sends `NOTIFY autologger_jobs` to wake workers. Workers claim
  with `FOR UPDATE SKIP LOCKED`, heartbeat `locked_at` every minute, retry failures up to 3 attempts
  with backoff (30 s, 60 s), and requeue jobs stuck in `running` for more than 15 minutes. Errors
  that cannot succeed on retry (bad Deepgram key, missing yt-dlp) fail immediately.
- **transcribe**: streams the object from S3 to Deepgram, maps utterances to `transcript_segments`
  (speaker `Speaker N`, times offset by the segment's `startSec`) and replaces that segment's previous
  transcript in one transaction. Machine writes are not recorded in the change log.
- **youtube_import**: yt-dlp downloads the audio to a temp dir, the worker uploads it, creates an
  `origin = 'youtube'` segment at `startSec` 0, sets `sessions.source_kind/source_url` and enqueues
  `transcribe`.
- Realtime: the worker publishes `audio_segment` / `job` changes and `transcript_segment` /
  `session` invalidations through the bus (Postgres NOTIFY), so open session pages update live.
