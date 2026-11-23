---
title: Importing from YouTube
section: guide
order: 70
description: Import a video or a whole playlist, give the server a YouTube sign-in, or import from your own computer.
---

# Importing from YouTube

Paste a video or a whole playlist. AutoLogger creates one session per video, downloads the audio
and transcribes it, so last season is as searchable as tonight's show. Downloads and transcription
run in the background on the server.

YouTube import has to be turned on for your server, with audio storage set up; if it isn't, the
import options say so.

## Import a playlist

1. Choose **Import** in the sidebar and switch the dialog to **YouTube playlist**.
2. Pick the **Show** and paste the **Playlist link**.
3. Choose the **Episode order**: **Playlist order**, or **Reverse** when the playlist lists the
   newest video first.
4. Optionally set a **Session title**: `{title}` is the video title and `{episode}` the episode
   number. Left empty, sessions take the video title.
5. Choose **Preview** to see what will be created and skipped, then **Import N videos** to
   start.

Videos already in the show, and private or deleted ones, are skipped, so importing the same
playlist later adds only new videos. A playlist can have up to 200 videos. Episode numbers come
from the show's episode counter, and each session's date becomes the video's upload date.

## Import one video

- **Into a new session**: in **New session**, open **Import audio** and paste a **YouTube link**.
- **Into an open session**: **Audio › Import from YouTube…**, then paste the **Link to YouTube
  video**.

Playlist links don't work here; use the playlist import above.

## Follow an import

The sidebar's **Background jobs** button lists the show's imports and transcriptions while they run
and keeps failures listed until you **Retry** or **Dismiss** them. A session's transcript appears
in its Transcript tab once its audio is downloaded and transcribed.

## Give the server a YouTube sign-in

YouTube often blocks downloads from servers until someone signs in ("Sign in to confirm you're not
a bot"). Team owners and admins can give the server a YouTube sign-in for the whole team in
**Settings › Team details › YouTube access**. Every show of the team then downloads as that
account, including private and members-only videos it can watch.

yt-dlp, which does the downloading, can't sign in with a password, so the sign-in is the cookies of
a browser signed in to YouTube. Two ways to set it:

- Run the import helper's `youtube-login` command on your computer (the card shows it with your
  team id), which reads the cookies from your browser and sends them:

  ```sh
  node autologger-import.mjs youtube-login --team <teamId> --cookies-from-browser firefox
  ```

- Or export youtube.com's cookies with a cookies.txt browser extension, then paste them or
  **Choose file**, and **Save cookies**.

The cookies are checked against YouTube right away, and the card shows when they last worked.
**Replace cookies** sets fresh ones; **Remove** deletes the sign-in.

Use a spare Google account: the cookies give full access to it. They last longest from a browser
profile used only for this; signing out there, or browsing YouTube in that profile, can end the
server's sign-in. When imports start failing with a sign-in error, set fresh cookies.

## Import from your own computer

When the team sign-in doesn't help, or for a private playlist, use the **AutoLogger import helper**.
It runs yt-dlp on your computer with your browser's YouTube sign-in and uploads only the audio. It
also builds compilations made to be built locally.

**Settings › Agents › Import from your computer** has the download link and ready-to-copy commands.
You need Node.js 22 or newer and yt-dlp (and ffmpeg for compilations), plus a personal access token
from the same page.

```sh
export AUTOLOGGER_URL=https://autologger.example.com
export AUTOLOGGER_TOKEN=alp_…
node autologger-import.mjs playlist '<playlist-url>' --show <showId> --cookies-from-browser chrome
node autologger-import.mjs video '<video-url>' --show <showId> --cookies-from-browser chrome
node autologger-import.mjs compile <compilationId> --cookies-from-browser chrome
```

`--cookies-from-browser` names the browser you're signed in to YouTube with (chrome, firefox, edge,
safari…). `--dry-run` shows what would happen without changing anything. Re-running a command
resumes it. Every option is in [Import helper](/docs/developers/import-helper).

## Import audio without transcribing

Agents can import videos without transcribing them (the `transcribe: false` option of the import
tools), and the import helper has `--no-transcribe`. The audio is stored and drawn on the timeline.
Transcribe it later with **Transcribe again** in **Audio › Audio segments**, or with **Save &
re-transcribe** in the Key terms dialog.

## Let an agent do it

The [import-videos skill](/docs/agents/plugins#autologger) imports a video or playlist, checks the
team's YouTube sign-in first, sets key terms such as guest names before transcription starts, and
can annotate each session afterwards. It previews a playlist before importing it, because agents
can't delete sessions.

## Related

- [Transcripts](/docs/guide/transcripts): key terms and fixing the transcript.
- [Ask and compilations](/docs/guide/ask-and-compilations): videos cut from imported sessions.
- [Self-hosting](/docs/developers/self-hosting): server-wide YouTube settings.
