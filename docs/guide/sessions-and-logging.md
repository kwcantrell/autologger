---
title: Sessions and logging
section: guide
order: 20
description: Shows, sessions, event buttons, hotkeys, the transport, takes, timecode settings and exports.
---

# Sessions and logging

Each show gets its own event buttons. While a session rolls, number keys 1–9 log them on the
session clock, so nobody types a timecode by hand. Everyone with the session open sees the same
transport and the same log, live.

## Shows and sessions

A **show** holds sessions and their shared settings: event buttons, frame rate, naming and
transcription settings. A **session** is one recording, episode or shoot. It holds the event log,
audio, transcript, topics, dashboards and its wiki recap.

Show settings live in **Settings › Show details** (name, code, suffix, next episode, default frame
rate, transcription settings) and **Settings › Event buttons**. Only team owners and admins can
change them.

## Create a session

Choose **New session** in the sidebar. The dialog asks for:

| Field             | Notes                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| Show              | Only shows you can write to are listed.                                  |
| Title (optional)  | Left empty, the show code plus the date or episode number names it.      |
| Episode           | Suggests the show's next episode number.                                 |
| Date              | Defaults to today.                                                       |
| Notes (optional)  | Free text.                                                               |
| Timecode settings | Frame rate and start timecode; collapsed by default.                     |
| Import audio      | A YouTube link or an audio file to add right away; collapsed by default. |

Choose **Create & open**. The **Import** button next to **New session** opens the same dialog with
the audio section expanded, and offers **YouTube playlist** for one session per video; see
[Importing from YouTube](/docs/guide/importing-from-youtube).

## Set up event buttons

Owners and admins edit a show's buttons in **Settings › Event buttons**. Each button has a name, a
colour, a type and a position.

| Type     | What a press does                                                         |
| -------- | ------------------------------------------------------------------------- |
| Button   | Logs one event with the button's name.                                    |
| Dropdown | Asks you to choose an option; the option becomes the event message.       |
| Text     | Asks for a short note, which becomes the event message.                   |
| On / Off | Toggles between two states and logs each change with its On or Off label. |

The first nine buttons get the keys 1 to 9 in order; use **Move up** and **Move down** to change
which is which. Later buttons have no key. A show can have up to 40 buttons. Deleting a button
keeps the events already logged with it.

**Copy from another show** replaces this show's buttons with a copy of another show's.

Button changes are recorded in the show's change log and can be undone; see
[Changes and undo](/docs/guide/changes-and-undo).

## Roll timecode

The transport at the top of a session controls the session clock. Every client with the session
open, and every Companion device following it, sees the same state.

| Control         | What it does                                                                      |
| --------------- | --------------------------------------------------------------------------------- |
| Roll timecode   | Starts the clock. Each roll starts a new take.                                    |
| Stop timecode   | Stops the clock. The elapsed time is kept, so the next roll carries on from it.   |
| Reset timecode  | Sets the stopped clock back to the session start. Logged events keep their times. |
| Record audio    | Records your microphone while timecode rolls. Stopping timecode ends it.          |
| Previous marker | Jumps the playhead to the previous event (not while live).                        |
| Next marker     | Jumps the playhead to the next event (not while live).                            |

Once a session has more than one take, the take number shows next to the timecode.

## Log an event with a hotkey

While timecode rolls, the event buttons replace the timeline. Press 1 to 9 to log the matching
button, or click any button.

- Hotkeys only work while timecode is rolling, and never while you are typing in a field.
- A **Dropdown** opens **Choose option**; after you pick one you can add an optional note and choose
  **Log**.
- A **Text** button opens **Log note** for the message.
- Dropdown and Text events keep the moment of the press, however long you take to type.
- An **On / Off** button shows its current state and flips it on each press.

If a show has no buttons yet, the strip links to **Settings › Event buttons**.

## Review and edit the log

The **Event Feed** tab lists every event in timecode order.

- **Time display** switches between **Session Time** and **World Clock (UTC)**.
- **Filter** hides categories you don't want to see.
- **Edit** (while timecode is stopped) lets you change an event's timecode, button and message in
  place. **Done** ends editing.
- Deleting a row asks first; it can be restored from the Agents tab.
- Events logged by an agent or from a Companion device carry a small badge saying so.

Select an event's time to play the audio from there. Playback is off while timecode rolls.

## Play back on the timeline

When timecode is stopped, the timeline shows the audio waveform and a marker for each event.
Select a marker to find its row in the Event Feed. Click or drag on the timeline to move the
playhead.

## Set the frame rate and start timecode

Every session has a frame rate and a start timecode (HH:MM:SS:FF). New sessions take the show's
default frame rate; set both under **Timecode settings** when you create a session, or later in
**Details**.

Frame rates: 23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94 and 60 fps.

Change them only while the transport is stopped. Logged events keep their place against the audio
and transcript, and their timecodes are re-read on the new clock. The change, with every event it
retimed, can be undone from the Agents tab.

## Edit session details

**Details** in the session's tab row opens **Session details**:

| Field          | Notes                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| Title          | Required.                                                                                                    |
| Episode        | Free text, such as `12` or `12b`.                                                                            |
| Date           | The episode date.                                                                                            |
| Notes          | Free text.                                                                                                   |
| Frame rate     | See above.                                                                                                   |
| Start timecode | See above.                                                                                                   |
| Key terms      | Names the transcriber listens for; see [Transcripts](/docs/guide/transcripts#steer-spelling-with-key-terms). |

If someone else changed the session while you had the dialog open, it says which fields changed.
Saving keeps their changes, except in fields you edited.

## Archive or delete a session

Open a session's menu in the sidebar:

- **Close session** returns to the home screen.
- **Details…** opens Session details.
- **Archive** moves it to **Archived**. **Restore** brings it back.
- **Delete** removes the session with its events, transcript, topics, dashboards and audio. Only
  team owners and admins can delete sessions, and it cannot be undone.

## Export the log

The **Export** tab downloads each feed of a session as a file.

| Export                     | Contents                                                       |
| -------------------------- | -------------------------------------------------------------- |
| Event feed CSV             | Every logged event with timecode, category, value and message. |
| Transcript (text)          | Speaker-labelled plain text.                                   |
| Transcript subtitles (SRT) | Timed captions for video editors.                              |
| Topics CSV                 | Start, duration, level, title and summary.                     |
| Event feed JSONL           | One JSON object per event, for scripts.                        |

## Keyboard shortcuts

| Keys           | What they do                                                         |
| -------------- | -------------------------------------------------------------------- |
| 1 to 9         | Log the 1st to 9th event button (while timecode is rolling)          |
| Space          | Play or pause recorded audio                                         |
| Left and Right | Scrub the timeline 1 s when the playhead is focused (Shift for 10 s) |
| Plus and Minus | Zoom the timeline in or out                                          |
| `[`            | Show or hide the sidebar                                             |
| Ctrl+K or ⌘K   | Search sessions, transcripts, topics and events                      |
| Esc            | Close dialogs and the drawer                                         |
| ?              | Open the shortcut reference                                          |

Shortcuts stay out of the way while you type in any field.

## Related

- [Companion](/docs/guide/companion): log and roll from a Stream Deck.
- [Transcripts](/docs/guide/transcripts): record and transcribe audio.
- [Changes and undo](/docs/guide/changes-and-undo): undo edits to events and buttons.
