---
title: Ask and compilations
section: guide
order: 60
description: Ask a question about a show, get cited answers in the wiki, and cut the moments into one video.
---

# Ask and compilations

Ask a question about a show and an agent answers with the ranges in each episode where it comes up,
saved to the wiki as a cited question page. When the episodes came from YouTube, AutoLogger cuts
those ranges into one video you can play or download.

## Ask a question

Install the `autologger-ask` plugin for Claude Code (it needs the `autologger` plugin; see
[Plugins](/docs/agents/plugins#autologger-ask)) and ask in plain words:

> What has Tom said about pricing across the show?

The [ask skill](/docs/agents/plugins#autologger-ask) searches the show, reads the sessions where
search misses paraphrases, and answers with a timecode range for every claim. It saves the answer
as a **Question** page in the show's wiki, so the knowledge base grows with every question. It
checks existing question pages first, so it doesn't answer the same question twice.

For a quick lookup without saving anything, the
[find-moments skill](/docs/agents/plugins#autologger) answers with session titles and timecodes.

## Search it yourself

Press Ctrl+K (⌘K on a Mac) to search sessions, transcripts, topics, events and wiki pages. **See all
results** opens the full search page, where you can filter by show. Selecting a moment opens its
session at that time.

## Make a video

A compilation is one MP4 cut from ranges of a show's sessions. Start one from:

- **Make video** on a wiki page with citations, such as a question page.
- **Make video** on a session's Topics tab.
- **Make video** on the search page, from the moments found.
- An agent: the [compile-clips skill](/docs/agents/plugins#autologger-ask), or the
  `compilations_create` tool.

The **Make a video** dialog lists the clips: tick the ones you want, give the video a **Title**, and
choose **Make video**. The server downloads just those sections of the YouTube videos and joins
them into one MP4. It takes a few seconds per clip-minute.

Only sessions imported from YouTube, with their audio stored, can be compiled. Sessions recorded or
uploaded in the app have no video to cut.

| Limit                 | Value                      |
| --------------------- | -------------------------- |
| Clips per video       | 1 to 100                   |
| Clip length           | 1 second to 20 minutes     |
| Total length          | 3 hours                    |
| Ranges without an end | 60 seconds (in the dialog) |
| Output                | MP4, 1280×720, 30 fps      |

Each clip also logs a **Compilation** event at its start in its session, so everyone can see which
moments were already clipped. Deleting the compilation removes those events again.

You need write access to the show to make videos.

## Watch and download compilations

**Compilations** in the top bar lists the show's videos, newest first.

| Status   | Meaning                                                   |
| -------- | --------------------------------------------------------- |
| Queued   | Waiting for the server; shows its place in the queue.     |
| Building | Being cut and joined; shows progress such as "clip 3/12". |
| Ready    | Play it in the page, or **Download** it.                  |
| Failed   | Shows why; **Retry** builds it again.                     |

**Delete** removes the video. It cannot be undone, but the sessions are not affected.

## When YouTube blocks the server

A server build fails when YouTube asks for a sign-in: its bot check ("YouTube is blocking this
server's downloads"), or a private, members-only or age-restricted video. The failed compilation
then shows what to do, in this order:

1. **Set the team's YouTube sign-in** (Settings › Team details › YouTube access; team owners and
   admins), then **Retry**. This is the usual fix and keeps future builds on the server. See
   [Importing from YouTube](/docs/guide/importing-from-youtube#give-the-server-a-youtube-sign-in).
2. **Build on my computer** switches the same compilation (same title, clips and events) to a local
   build with the import helper, which downloads with your own browser's sign-in. The card then
   shows **Waiting for a local build** with its **Build command**: copy it and run it where the
   helper is set up (Settings › Agents › Import from your computer). The video appears here once it
   is uploaded.

A compilation that is still queued for the server can also be switched by an agent
(`compilations_retry` with `buildLocally: true`); one the server is building right now cannot.

## Related

- [Wiki](/docs/guide/wiki): question pages and citations.
- [Example prompts](/docs/agents/example-prompts#ask-and-compile)
