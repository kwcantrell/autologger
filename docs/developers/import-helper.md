---
title: Import helper
section: developers
order: 30
description: The autologger-import command-line helper that downloads YouTube audio on your own computer, bulk-imports local audio files, builds local compilations and hands the server a YouTube sign-in.
---

YouTube often bot-checks downloads from datacenter IPs (see
[YouTube bot check](/docs/developers/self-hosting#youtube-bot-check)), and the server can never
read **private** videos and playlists. The local import helper runs yt-dlp on the user's own computer — their home IP, their browser's YouTube
cookies (`--cookies-from-browser`) — and sends only the audio (or a finished compilation MP4) to
AutoLogger. No cookies reach the server, except with `youtube-login` (below).

## Download

The server serves the helper as one dependency-free file (Node ≥ 22, no `npm install`):

```sh
curl -fLO https://<your-autologger>/api/importer/autologger-import.mjs
```

`GET /api/importer/autologger-import.mjs` needs no sign-in (it is the same code as
`apps/importer` in this repo). The file is read from `IMPORTER_FILE` (default
`apps/importer/autologger-import.mjs` next to the server source); the route answers 404 when it
is missing. It is a file route like the exports, not an op.

The web app points users at it: Settings › Agents › _Import from your computer_ has the download
link, `AUTOLOGGER_URL` / `AUTOLOGGER_TOKEN` and example commands; import dialogs and the
background jobs list link there (and to the team's YouTube sign-in, the usual fix) when an import
fails with YouTube's bot check or a sign-in error; and the Compilations page shows a `buildLocally`
compilation that is still queued as "Waiting for a local build" with its copyable `compile` command.

## Use

```sh
export AUTOLOGGER_URL=https://<your-autologger>
export AUTOLOGGER_TOKEN=alp_…            # Settings › Agents › Personal access tokens
node autologger-import.mjs playlist '<playlist-url>' --show <showId> --cookies-from-browser chrome
node autologger-import.mjs video '<video-url>' (--show <showId> | --session <sessionId>)
node autologger-import.mjs compile <compilationId>
node autologger-import.mjs files <folder | manifest.csv> --show <showId> [--parallel 3]
```

Needs yt-dlp (and ffmpeg + ffprobe for `compile`; neither for `files`) on the user's computer; it says how to install
them when they are missing. `--cookies-from-browser <browser>` / `--cookies <file>` are passed to
yt-dlp; `--dry-run` changes nothing; re-running a command resumes. All options:
[apps/importer/README.md](https://github.com/kwcantrell/autologger/blob/main/apps/importer/README.md).

## What it calls

The helper authenticates with a personal access token (Settings › Agents) as `Authorization:
Bearer alp_…` and calls `POST /api/rpc/<op>`, so it gets the MCP surface and acts as the user:

| Step                     | Op                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions for a playlist  | `media.importPlaylist` with `videos: [{url, title, durationSec?, uploadDate?}]` instead of `url`: same skipping, titles, episodes and `dryRun`, but no download jobs.                                                                                                                                                                                                        |
| Upload one video's audio | `media.createUpload` with `origin: "youtube"`, `youtube: {url, title?, uploadDate?, private?}` → PUT → `media.completeUpload` (waveform; transcription unless `transcribe: false`).                                                                                                                                                                                          |
| Resume                   | `media.list`: a session whose YouTube segment is stored (status other than `uploading`) is done. A new YouTube upload replaces an unfinished one of the session.                                                                                                                                                                                                             |
| Local audio files        | `media.importFiles` (up to 100 files per call: `{fileName, sizeBytes, mimeType, title?, episode?, episodeDate?, notes?, keyTerms?}`) → one new session and upload each → PUTs (in parallel) → `media.completeUploads` (durations are measured by the waveform job). A file is recognized by name + size in the show: re-runs skip uploaded files and resume unfinished ones. |
| Large files              | Over 32 MiB, every upload (`media.createUpload`, `media.importFiles`, `compilations.createUpload` with `sizeBytes`) returns `parts` instead of `uploadUrl`: PUT bytes `[offset, offset + sizeBytes)` to each part URL; parts already stored on a resume are marked `uploaded`. Transient storage errors (e.g. a proxy's 524) are retried per part.                           |
| Build a compilation      | `compilations.create` with `buildLocally: true` (or `compilations.retry` with `buildLocally: true` for a failed / still-queued server build; no compile job), then `compilations.createUpload` (clip plan in video seconds + presigned PUT) → PUT → `compilations.completeUpload` (ready).                                                                                   |

A YouTube upload stores the video URL on the segment (`audio_segments.source_url`) and, once
completed, makes it the session's source (`sessions.source_kind/source_url`), so the session can be
compiled like a server import. `private: true` (`audio_segments.source_private`) marks audio the
server could never download: `compilations.create` / `compilations.retry` and the worker's
`compile` job refuse clips of it with a message pointing at `buildLocally`.

## Importing local audio files (`files`)

For an archive of recordings on disk — mp3, m4a, aac, wav, flac, ogg/opus, webm, aiff, mp4 or
mov — `files` creates one session per file in a show and uploads them without an agent in the
loop:

```sh
node autologger-import.mjs files ~/Archive/Season1 --show <showId> --dry-run   # what it would do
node autologger-import.mjs files ~/Archive/Season1 --show <showId> --no-transcribe
node autologger-import.mjs files manifest.csv --show <showId>
```

A folder imports its audio/video files (not subfolders) in name order, titled by the file name.
A CSV manifest names the columns in its first row: `file` (path relative to the CSV) and,
optionally, `title`, `episode`, `episodeDate` (YYYY-MM-DD), `notes` and `keyTerms` (terms
separated by `;`). Episodes without a number take the show's next one. Files over 32 MiB go up in
parts; `--parallel <n>` (default 3) uploads that many files at a time. Run the same command again
after an interruption: uploaded files are skipped and unfinished ones resume with their missing
parts, in the same sessions.

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
[Self-hosting › YouTube bot check](/docs/developers/self-hosting#youtube-bot-check).
