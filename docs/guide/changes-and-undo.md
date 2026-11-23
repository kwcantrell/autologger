---
title: Changes and undo
section: guide
order: 80
description: See every change by operators and agents, filter by who made it, and undo one change or a whole call.
---

# Changes and undo

Agents change your sessions right away, as you. To keep that safe, AutoLogger records each content
change with who made it and from where, and lets you undo it. The session's **Agents** tab shows a
session's changes; the **Changes** page shows a whole show's.

## What is recorded

| Kind          | Examples                                                             |
| ------------- | -------------------------------------------------------------------- |
| Events        | Logged, edited and deleted events.                                   |
| Topics        | Added, edited, replaced and deleted topics.                          |
| Transcript    | Edited lines, renamed speakers, merges, splits, imports.             |
| Dashboards    | Saved, edited and deleted dashboards.                                |
| Session clock | Frame rate and start timecode changes, with the events they retimed. |
| Event buttons | Added, edited, reordered and removed buttons.                        |
| Wiki pages    | Saves, restores and deletes.                                         |

Not recorded, and so not undoable from here: show settings (including key terms and replacement
rules), other session details such as the title and notes, audio, and compilation videos.

## The Agents tab

Every session has an **Agents** tab. At the top it shows how to connect an agent (the MCP URL and
the Claude Code command); below, the session's change log, newest first.

Each row shows when, who, from where (an agent's client name or a Companion device), the kind of
item and a summary. Filter the list to **All changes**, **Agents only** or **Operators**.

## Undo one change

Choose **Undo** on a row and confirm. The undo is recorded too, and can itself be undone.

Only the most recent change to an item can be undone, so undo newer changes to the same item
first.

## Undo a whole call

Agents often change many things in one call: a topic list, hundreds of transcript lines, a batch of
events. Those changes are folded into one row with **Undo all**, which reverts everything the call
changed in one step.

- Changes already undone one by one are skipped.
- If anything in the call was changed again later, nothing is undone; undo the newer change first.
- If the call also changed other sessions, **Undo all** reverts those too, and you need edit access
  to all of them.

## The Changes page

**Changes** in the sidebar opens the change log of the show chosen in the top bar. It covers every
session, plus wiki pages and event buttons, which belong to no session. Filters:

| Filter | Options                                                                                |
| ------ | -------------------------------------------------------------------------------------- |
| Where  | **Whole show**, **Show-level only (wiki, event buttons)**, or one session              |
| Kind   | **All kinds**, or one kind from the table above                                        |
| Who    | **Everyone**, **Agents only**, **Operators**, or one agent or Companion device by name |

The filters are part of the page address, so you can share a filtered view. Session rows link to
the moment they changed. New changes appear while the page is open, and an agent or Companion
device that changes the show for the first time joins the **Who** list as soon as its change shows
up in the list.

You need write access to a show to undo its changes; with read access you can still see them.

## Related

- [Connecting agents](/docs/agents/connecting-agents): how agents act as you.
- [Teams and access](/docs/guide/teams-and-access): read and write access.
