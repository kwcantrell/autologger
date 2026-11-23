# autologger-import

The AutoLogger local import helper. It runs **yt-dlp on your own computer** — your home
internet connection, your browser's YouTube sign-in — and sends only the audio (or a finished
compilation video) to AutoLogger. Use it when:

- the playlist or video is **private** (or members-only), which the AutoLogger server can never read;
- an import fails with **"YouTube is blocking this server's downloads (bot check)"**;
- a compilation of such sessions has to be **built on your computer**.

Your YouTube cookies never leave your machine; AutoLogger only sees a personal access token.

## Install

You need [Node.js](https://nodejs.org) 22 or newer, [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation)
and, for compilations, [ffmpeg](https://ffmpeg.org/download.html) (with ffprobe):

```sh
brew install node yt-dlp ffmpeg          # macOS
sudo apt install nodejs ffmpeg && pipx install yt-dlp   # Debian/Ubuntu (Node 22+)
```

Download the helper from your AutoLogger server (one file, no `npm install`):

```sh
curl -fLO https://<your-autologger>/api/importer/autologger-import.mjs
```

## Configure

```sh
export AUTOLOGGER_URL=https://<your-autologger>
export AUTOLOGGER_TOKEN=alp_…   # Settings › Agents › Personal access tokens
```

## Use

```sh
# A whole (private) playlist into a show: one session per video, audio uploaded, transcribed.
node autologger-import.mjs playlist 'https://www.youtube.com/playlist?list=PL…' --show <showId> \
  --cookies-from-browser chrome

# One video: a new session in a show, or into an existing session.
node autologger-import.mjs video 'https://youtu.be/…' --show <showId> --cookies-from-browser firefox
node autologger-import.mjs video 'https://youtu.be/…' --session <sessionId>

# Build a compilation created with buildLocally (the web app / your agent tells you the id).
node autologger-import.mjs compile <compilationId> --cookies-from-browser chrome
```

| Option                               | Meaning                                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `--cookies-from-browser <browser>`   | yt-dlp reads your YouTube sign-in from this browser (`chrome`, `firefox`, `edge`, `safari`, `brave`, … `[:profile]`). |
| `--cookies <file>`                   | A Netscape `cookies.txt` instead.                                                                                     |
| `--dry-run`                          | Show what would be created, uploaded or built; change nothing.                                                        |
| `--no-transcribe`                    | `playlist` / `video`: upload the audio (and draw its waveform) without transcribing it; transcribe later if needed.   |
| `--order playlist\|reverse`          | playlist: episode numbers follow the playlist; reverse when it lists newest first.                                    |
| `--title-template <t>`               | Session titles, with `{title}` and `{episode}` (default `{title}`).                                                   |
| `--work-dir <dir>`                   | Where downloads and clips go (default `~/.cache/autologger-import`).                                                  |
| `--keep`                             | Keep the downloaded files after a successful upload.                                                                  |
| `--yt-dlp <path>`, `--ffmpeg <path>` | The tools, if not on `PATH` (also `YTDLP_PATH`, `FFMPEG_PATH`).                                                       |

**Resuming.** Run the same command again after an interruption: videos whose audio is already in
AutoLogger are skipped, partial downloads continue, and compilation clips already encoded are
reused. Sessions are never created twice for the same video in a show.

**Sessions** get the same titles, episode numbers and dates as a server-side playlist import. Their
audio is transcribed (unless `--no-transcribe`) and drawn as a waveform like any upload. Videos the server cannot download
(private ones) are marked so: compilations of them must be built with this helper.

**Compilations** are encoded exactly like the server's: each clip's section is downloaded at up to
720p, re-encoded to 1280×720 30 fps H.264 with 48 kHz stereo AAC and joined into one MP4, which then
appears ready on the Compilations page.

Exit codes: 0 done, 1 failed (the message says why), 2 usage or configuration error.

## Develop

`apps/importer/autologger-import.mjs` is plain JavaScript checked by TypeScript (`// @ts-check`,
`npm run typecheck -w @autologger/importer`) so the server can serve it as is. Tests run it against
fake yt-dlp/ffmpeg scripts and a stub AutoLogger server (`npm test -w @autologger/importer`); they
never touch the network. Keep its yt-dlp format and ffmpeg arguments in step with
`apps/server/src/media/youtube.ts` and `apps/server/src/media/compilations.ts`. The ops it calls are
listed in [docs/developers/import-helper.md](../../docs/developers/import-helper.md).
