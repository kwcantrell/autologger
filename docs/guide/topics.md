---
title: Topics
section: guide
order: 35
description: Chapters for a session, written by an agent from the transcript or by hand.
---

# Topics

Topics break a session into named chapters with start times and lengths. Write them yourself, or
ask an agent to chapter the transcript and review what it wrote. Topic start times line up with
events and transcript lines, because they all use the same session clock.

## What a topic holds

| Field    | Notes                                                  |
| -------- | ------------------------------------------------------ |
| Start    | Seconds from the session start, shown as a clock time. |
| Duration | In seconds.                                            |
| Level    | 1 for a major segment, 2 and 3 for sub-topics.         |
| Title    | The chapter name.                                      |
| Summary  | Optional, a line or two about what happens.            |

## Generate topics with an agent

AutoLogger doesn't generate topics itself. An agent connected over MCP reads the transcript and
events and writes the topics for you, as you.

- With the `autologger` plugin, ask Claude to "chapter this session"; the
  [session-topics skill](/docs/agents/plugins#autologger) takes it from there.
- Without the plugin, any MCP client can use the server's `generate_topics` prompt, or the
  `topics_replace` tool.

An agent replaces the whole topic list in one call. Every topic it removed or added shows in the
Agents tab, where you can undo the call; see [Changes and undo](/docs/guide/changes-and-undo).

If a session has no topics yet, the Topics tab links to **Settings › Agents** to connect one.

## Add and edit topics by hand

With write access to the show:

- **Insert** adds a "New topic" after the last one.
- Edit the start, duration, level, title and summary of any topic in place.
- Delete a topic with its delete button. It can be restored from the Agents tab.

Topics an agent wrote carry a small badge saying so.

## Jump to a topic

Select a topic's start time to play the session's audio from there. Playback is off while
timecode rolls.

## Make a video from topics

For a session imported from YouTube, **Make video** on the Topics tab cuts chosen topics into one
MP4; see [Ask and compilations](/docs/guide/ask-and-compilations#make-a-video).

## Export topics

The **Export** tab's **Topics CSV** has start, duration, level, title and summary for each topic,
ready to paste into show notes.

## Related

- [Transcripts](/docs/guide/transcripts): clean up the transcript before chaptering.
- [Example prompts](/docs/agents/example-prompts#topics)
