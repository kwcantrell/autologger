---
title: Transcripts
section: guide
order: 30
description: Record or import audio, steer transcription with key terms and rules, and fix lines and speakers.
---

# Transcripts

Record in the browser or upload a file, and AutoLogger transcribes it with speaker labels. Each
line is timecoded to the same clock as your log, so selecting a word jumps the player there.

Transcription runs in the background on the server. If your server has no transcription set up,
audio is still stored and playable, and agents can add transcript lines over MCP.

## Add audio to a session

Use the **Audio** menu in the session's tab row:

| Item                 | What it does                                                                 |
| -------------------- | ---------------------------------------------------------------------------- |
| Import audio file…   | Uploads an audio or video file. It is placed after the session's last audio. |
| Import from YouTube… | Downloads the audio of one video in the background.                          |
| Audio segments       | Lists the session's audio with each segment's status.                        |
| Key terms…           | Names the transcriber listens for in this session.                           |

You can also record: choose **Record audio** while timecode rolls. Recording follows the session
clock and stops when timecode stops. Each recording, file or import is one **audio segment** and
is transcribed on its own.

Audio segment statuses: Uploading, Ready, Transcribing, Transcribed, Failed. In **Audio segments**
you can **Transcribe again** or **Delete** a segment. Deleting removes its audio and the transcript
made from it, and cannot be undone.

## Follow transcription progress

The **Transcript** tab shows a status next to the word count: No transcript, Transcribing…, Partly
transcribed, Transcribed or Transcription failed. Lines appear as they finish.

The **Background jobs** button in the sidebar lists YouTube imports, transcriptions and video
compilations of the show that are queued, running or failed. A failed job offers **Retry** (or
**Transcribe again**) and **Dismiss**.

## Steer spelling with key terms

Key terms are names and jargon the transcriber should listen for, such as a guest's name.

- **Session key terms**: **Audio › Key terms…**, or **Edit key terms…** in Session details. Use
  these for anything said in this session only, such as guests.
- **Show key terms**: **Settings › Show details › Key terms**, one per line. They are sent with
  every session of the show, after the session's own terms.

Keep show key terms to names said in every session, like the hosts and the show's name. The
transcriber can push a key term into audio that doesn't contain it, so a guest's name on the show
can turn up in other episodes.

| Limit               | Value         |
| ------------------- | ------------- |
| Terms per list      | 50            |
| Characters per term | 50            |
| Characters in total | 1000 per list |

Key terms apply to transcriptions that run after you save them. To use them on audio already
transcribed, choose **Save & re-transcribe** in the Key terms dialog. Re-transcribing replaces the
machine transcript, and manual edits to it are lost.

## Turn smart formatting off

**Settings › Show details › Smart formatting** writes numbers, dates and money as digits and
symbols. Turn it off for technical or math talk, where it turns "x squared" into "x2". It applies to
new transcriptions; re-transcribe a session to update it.

## Fix repeated mistakes with replacement rules

**Settings › Show details › Replacement rules** fixes words the transcriber keeps getting wrong,
such as "doctor" for "dr". Each rule has **Find** and **Replace with**, plus options:

| Option | Meaning                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| Aa     | Match case. Off by default: rules ignore case.                                   |
| Ab     | Keep case: "The doctor" becomes "The dr". On by default.                         |
| Word   | Whole words only.                                                                |
| .\*    | Regular expression (PostgreSQL syntax); `\1` in Replace inserts the first group. |

Rules run in order when a session is transcribed, and again whenever it is re-transcribed. A show
can have up to 100 rules. To apply them to a transcript you already corrected by hand, without
re-transcribing, ask an agent: the `transcript_replace` tool applies the show's rules and keeps
manual edits.

## Edit a line

With write access, hover a line and choose the pencil (**Edit segment**). Press Enter to save,
Shift+Enter for a new line, or Esc to cancel. Words you don't change keep their timings.

## Rename a speaker

Select a speaker's name, such as "Speaker 1", to open **Rename speaker**. The new name replaces it
in every line of the session. An agent can rename just part of a session, for example only the
intro.

## Fix a transcript with an agent

Agents can do what is slow by hand: find every misheard term, correct hundreds of lines in one call,
merge lines split mid-sentence, and split a turn that holds two speakers. The
[transcript-cleanup skill](/docs/agents/plugins#autologger) does this and reports what it changed.
Every edit shows in the Agents tab and can be undone, a whole call at once.

## Import a transcript file

When you already have a transcript, such as subtitles from an editor, load it instead of
transcribing the audio. Choose **Import transcript…** in the Transcript tab (or in the **Audio**
menu), then:

1. **Choose file**: an SRT or WebVTT subtitle file (`.srt`, `.vtt`), or a `.json` array of lines
   with `startSec`, `endSec`, `speaker` and `text`. The file is read in your browser.
2. **Import into**: the whole session, where file times count from the session start, or one
   recording, where they count from the start of that recording and it is marked transcribed.
3. **Existing transcript**: **Replace** deletes the transcript already there (with a recording,
   only that recording's lines) before importing, including manual corrections and speaker
   renames. **Append** adds the file's lines and keeps the rest.

The dialog shows how many lines were imported and replaced and which speakers it found. A file it
can't read is refused with the line that failed, and nothing is changed. While a transcription of
the session or that recording is running, wait for it to finish first. The whole import can be
undone in one step from the Agents tab. Agents can do the same with the `transcript_import` tool.
You need write access to the show.

| Limit         | Value                |
| ------------- | -------------------- |
| File size     | 5,000,000 characters |
| Lines         | 10,000               |
| Text per line | 20,000 characters    |
| Speaker name  | 80 characters        |

Speaker names come from WebVTT voice tags or a label at the start of a cue, such as `Dana:`.

## Export the transcript

The **Export** tab downloads the transcript as speaker-labelled text or as SRT subtitles; see
[Sessions and logging](/docs/guide/sessions-and-logging#export-the-log).

## Related

- [Topics](/docs/guide/topics): chapters from the transcript.
- [Importing from YouTube](/docs/guide/importing-from-youtube): import audio from videos and
  playlists.
- [Self-hosting](/docs/developers/self-hosting): setting up storage and transcription on a server.
