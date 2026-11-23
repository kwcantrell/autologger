---
title: Getting started
section: guide
order: 10
description: Sign in, create a team and a show, start your first session and log a moment.
---

# Getting started

AutoLogger is a logging workspace for live productions. Teams hold shows, and shows hold
sessions. In a session you log events on timecode, record or import audio, and get a
speaker-labelled transcript. AI agents connected over MCP can then add topics, dashboards and wiki
pages for you, and every change they make can be undone.

This page takes you from sign-in to your first logged event.

## Sign in

Open your AutoLogger server and choose **Sign in with Google**. Your account is created the first
time you sign in; there is no separate sign-up form.

New accounts wait for an administrator of the server to approve them. You see a **Waiting for
approval** screen until then; choose **Check again** once you have been approved. If someone
invited your email address to a team, you are approved as soon as you sign in.

Administrators approve accounts in **Settings › Users**. See
[Teams and access](/docs/guide/teams-and-access#approve-new-accounts).

## Create your first team

If you are not on a team yet, AutoLogger asks you to **Create your first team**. Enter a **Team
name** and choose **Create team**. You become the team's owner and can invite people from
**Settings › Members** afterwards.

## Add a show

A show is a series of sessions: a podcast, a channel, a production. Owners and admins add shows in
**Settings › Shows › Add show**.

| Field              | What it does                                                               |
| ------------------ | -------------------------------------------------------------------------- |
| Show name          | Appears in the top bar and on every session.                               |
| Code               | Starts the name of every untitled session. Left empty, the initials.       |
| Suffix             | How an untitled session's name ends: the date, an episode number, or none. |
| Next episode       | The number the next new session suggests.                                  |
| Default frame rate | New sessions in this show start at this rate.                              |
| Who can open it    | Read or Write access for each member of the team.                          |

A new show starts with three event buttons: **Scene**, **Audio issue** (a dropdown with Lav, Boom,
Noise and Clipping) and **Note**. Change them in **Settings › Event buttons**; see
[Sessions and logging](/docs/guide/sessions-and-logging#set-up-event-buttons).

## Start a session

Choose **New session** at the top of the sidebar (or **Start a session** on the home screen). Pick
the show, optionally give it a title, and choose **Create & open**. Left empty, the title is the
show code plus the date or episode number.

## Log your first event

1. Choose **Roll timecode**. The session clock starts and the event buttons appear.
2. Press a number key from 1 to 9, or click a button. The event lands on the current timecode.
3. Choose **Stop timecode** when you are done. The Event Feed tab lists what you logged.

More in [Sessions and logging](/docs/guide/sessions-and-logging).

## Find your way around

| Where          | What's there                                                                              |
| -------------- | ----------------------------------------------------------------------------------------- |
| Top bar        | Team and show switchers, the live transport status, search, **Wiki** and **Compilations** |
| Sidebar        | **New session**, **Import**, **Recent sessions**, **Archived**, **Changes**, **Settings** |
| Search         | Press Ctrl+K (⌘K on a Mac) to search sessions, transcripts, topics, events and wiki pages |
| Shortcut sheet | Press ? in a session to see every keyboard shortcut                                       |
| Sidebar toggle | Press `[` to show or hide the sidebar                                                     |

Search also has a full page at `/search`, with a filter by show and **Load more** for long result
lists.

## Next steps

- [Transcripts](/docs/guide/transcripts): record or import audio and fix the transcript.
- [Importing from YouTube](/docs/guide/importing-from-youtube): bring in a back catalogue.
- [Connecting agents](/docs/agents/connecting-agents): let Claude chapter, log and document your
  sessions.
- [Teams and access](/docs/guide/teams-and-access): invite your crew.
