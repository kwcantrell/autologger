---
title: Companion
section: guide
order: 95
description: Roll, stop and log from a Stream Deck with Bitfocus Companion, with timecode and the last event on the keys.
---

# Companion

The AutoLogger module for Bitfocus Companion turns a Stream Deck, or any Companion surface, into a
logging surface. Roll and stop the transport, log events with the show's buttons, and show
timecode, take and the last event on the keys. Presses land in the same session, on the same clock,
as everyone else's.

## What you need

- Bitfocus Companion with the AutoLogger module (listed as **AutoLogger: Live Session Logging**).
- A device token from AutoLogger. Creating one needs the owner or admin role in the show's team.

## Create a device

1. In AutoLogger open **Settings › Companion devices**.
2. Under **Add a device**, choose the **Show** and give it a **Device name**, such as "Booth A".
3. Choose **Add device** and copy the **Device token**. It starts with `ald_` and is shown only
   once.

A device logs into one show, as you. If you lose access to the show, the device stops working.

## Install the module

The module comes as a package file, `autologger-<version>.tgz`. Ask whoever runs your AutoLogger
server for it, or build it from the AutoLogger repository; see
[Companion protocol](/docs/developers/companion-protocol).

In Companion, open **Modules**, choose **Import module package** and pick the file. A newer version
imports next to the old one; choose it per connection under **Module Version**.

## Connect it

1. In Companion, add a connection and search for "AutoLogger".
2. Set **AutoLogger server URL** to the address you open AutoLogger at in your browser, such as
   `https://autologger.example.com`.
3. Set **Device token** to the `ald_…` token.

**Bad configuration** means the URL or token is missing. **Error** with "Device token revoked"
means the token no longer works: create a new device and paste its token.

## Add buttons

The module's presets are the quickest start:

| Preset group      | Buttons                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| Transport         | Roll / Stop (one key that toggles), Roll, Stop                              |
| Status            | Timecode (with the take), Last event, Event count                           |
| Event buttons     | Button 1 to Button 9, named and coloured like the show's buttons            |
| Options: (button) | One key per option of a dropdown button, or per state of an On / Off button |

Or build your own with the actions:

| Action                          | What it does                                                     |
| ------------------------------- | ---------------------------------------------------------------- |
| Transport: roll / stop / toggle | Rolls or stops the session clock.                                |
| Log event (choose button)       | Logs a chosen event button, with an optional option and message. |
| Log event by hotkey slot (1–9)  | Logs whichever button is in that slot of the show.               |
| Refresh state from server       | Fetches the current state again.                                 |

Variables such as `$(autologger:timecode)`, `$(autologger:take)`, `$(autologger:last_event)` and
`$(autologger:event_count)` put live values on any key. Feedbacks light keys while the transport
rolls, warn when there is no session to control, and colour keys like the show's buttons.

## Choose the session it controls

By default a device follows its show: the session that is rolling, or else the newest one that
isn't archived. To pin it to one session, pick it in the device's row in **Settings › Companion
devices**; choose **Live or newest session** to follow the show again.

The row also shows whether the device is **Online** or **Offline** and when it was last seen.

## Revoke a device

**Revoke** in **Settings › Companion devices** stops the token at once and closes the device's
connection. The Stream Deck then needs a new device token.

## See what a device logged

Events logged from Companion carry a Companion badge in the Event Feed, and the change log names
the device; filter **Changes** by **Device:** and its name. See
[Changes and undo](/docs/guide/changes-and-undo).

## Related

- [Sessions and logging](/docs/guide/sessions-and-logging): event buttons and the transport.
- [Teams and access](/docs/guide/teams-and-access#companion-devices)
