## Local import helper

YouTube often bot-checks downloads from datacenter IPs (see _YouTube bot check_ in
[media.md](media.md)), and the server can never read **private** videos and playlists. The local
import helper runs yt-dlp on the user's own computer — their home IP, their browser's YouTube
cookies (`--cookies-from-browser`) — and sends only the audio (or a finished compilation MP4) to
AutoLogger. No cookies reach the server, except with `youtube-login` (below).

### Download

The server serves the helper as one dependency-free file (Node ≥ 22, no `npm install`):

```sh
curl -fLO https://<your-autologger>/api/importer/autologger-import.mjs
```

`GET /api/importer/autologger-import.mjs` needs no sign-in (it is the same code as
`apps/importer` in this repo). The file is read from `IMPORTER_FILE` (default
`apps/importer/autologger-import.mjs` next to the server source); the route answers 404 when it
is missing. It is a file route like the exports, not an op.

### Use

```sh
export AUTOLOGGER_URL=https://<your-autologger>
export AUTOLOGGER_TOKEN=alp_…            # Settings › Agents › Personal access tokens
node autologger-import.mjs playlist '<playlist-url>' --show <showId> --cookies-from-browser chrome
node autologger-import.mjs video '<video-url>' (--show <showId> | --session <sessionId>)
node autologger-import.mjs compile <compilationId>
```

Needs yt-dlp (and ffmpeg + ffprobe for `compile`) on the user's computer; it says how to install
them when they are missing. `--cookies-from-browser <browser>` / `--cookies <file>` are passed to
yt-dlp; `--dry-run` changes nothing; re-running a command resumes. All options:
[apps/importer/README.md](../apps/importer/README.md).

### What it calls

The helper authenticates with a personal access token (Settings › Agents) as `Authorization:
Bearer alp_…` and calls `POST /api/rpc/<op>`, so it gets the MCP surface and acts as the user:

| Step                     | Op                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions for a playlist  | `media.importPlaylist` with `videos: [{url, title, durationSec?, uploadDate?}]` instead of `url`: same skipping, titles, episodes and `dryRun`, but no download jobs.                          |
| Upload one video's audio | `media.createUpload` with `origin: "youtube"`, `youtube: {url, title?, uploadDate?, private?}` → PUT → `media.completeUpload` (transcription + waveform as usual).                             |
| Resume                   | `media.list`: a session whose YouTube segment is stored (status other than `uploading`) is done. A new YouTube upload replaces an unfinished one of the session.                               |
| Build a compilation      | `compilations.create` with `buildLocally: true` (no compile job), then `compilations.createUpload` (clip plan in video seconds + presigned PUT) → PUT → `compilations.completeUpload` (ready). |

A YouTube upload stores the video URL on the segment (`audio_segments.source_url`) and, once
completed, makes it the session's source (`sessions.source_kind/source_url`), so the session can be
compiled like a server import. `private: true` (`audio_segments.source_private`) marks audio the
server could never download: `compilations.create` / `compilations.retry` and the worker's
`compile` job refuse clips of it with a message pointing at `buildLocally`.

## Giving the server a YouTube sign-in (`youtube-login`)

Instead of downloading on your computer every time, you can hand your team a YouTube sign-in on
the server once; from then on the server imports and compiles all the team's videos by itself,
even from an IP YouTube bot-checks:

```sh
node autologger-import.mjs youtube-login --team <teamId> --cookies-from-browser firefox
```

It reads the browser's cookies with yt-dlp (`--cookies <file>` sends a cookies.txt instead) and
calls `media.setYoutubeCookies`, which keeps only the youtube.com and google.com cookies, tests
them on a public video and prints the result. `--show <showId>` instead of `--team` sets it for that show's team. Needs owner or admin in the
team. Use a
spare Google account (the cookies give full access to it), preferably in a browser profile used
only for this: signing out of YouTube there, or YouTube rotating the cookies of its open tabs,
ends the server's sign-in, and you run the command again. See
[media.md › YouTube bot check](media.md#youtube-bot-check).
