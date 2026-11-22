# AutoLogger

Drive an AutoLogger live session from Companion. The module keeps a WebSocket open to the
AutoLogger server; no browser needs to be open.

## Setup

1. In AutoLogger open **Settings → Companion devices**, pick the show and create a device.
2. Copy the **server URL** and the **device token** (starts with `ald_`, shown once).
3. Paste both into this connection's config. The token is kept in Companion's secrets store.

The device acts as the AutoLogger user who created it, limited to that one show.

## Which session?

By default the device controls the show's rolling session, or else its newest session. To pin a
specific session, choose it for the device in **Settings → Companion devices** (or from the
session page). Check `$(autologger:session_title)` on your keys before you press.

## Actions

- **Transport: roll / stop / toggle** — each roll starts a new take.
- **Log event (choose button)** — pick one of the show's event buttons (or type a free label).
  *Option / value*: for dropdown buttons the option to log, for toggle buttons `on`, `off` or
  `toggle` (empty = toggle). *Message* is free text; both accept variables.
- **Log event by hotkey slot (1–9)** — same as the app's number keys; follows the show's button
  order, so pages keep working when buttons are renamed.
- **Refresh state from server**.

## Feedbacks

- **Transport is rolling** (red), **No session to control** (amber).
- **Event button color** — colors a key like the event button in a slot.

## Variables

`session_title`, `show_name`, `device_name`, `timecode` (ticks locally while rolling), `take`,
`rolling`, `frame_rate`, `event_count`, `last_event`, `last_event_timecode`, `cat_1` … `cat_9`
(button names per slot).

## Presets

Transport (Roll/Stop toggle with timecode, Roll, Stop), status keys (timecode, last event, event
count), one key per event-button slot 1–9, and one key per dropdown option / toggle state of the
current show's buttons.

## Status

- **Authentication failure** — the token is wrong or the device was revoked: create a new device
  and paste its token. The module does not retry until the config changes.
- **Connection failure** — the server is unreachable; the module reconnects with backoff (1–30 s).
