# Bitfocus Companion

The Companion module (`apps/companion`) lets a Stream Deck or any Companion surface drive a live
AutoLogger session: roll/stop the transport, log events with the show's buttons, and show
timecode, take and the last event on keys.

## Setup

1. **Create a device.** In AutoLogger open **Settings → Companion devices**, choose the show and
   create a device (needs owner/admin on the show's team). Copy the token — it starts with `ald_`
   and is shown once. Only its SHA-256 hash is stored.
2. **Install the module.** `npm run build -w companion-module-autologger` (or `npm run package`
   for a `.tgz`), then load it as a developer module in Companion, or install the package.
3. **Configure the connection** in Companion: _Server URL_ = the address you open AutoLogger at
   (e.g. `https://autologger.example.com`), _Device token_ = the `ald_…` token.
4. Add presets from the **AutoLogger** preset list (transport, slots 1–9, options, status).

The device acts as the user who created it, limited to its one show and never above write
access. If that user is disabled or loses access to the show, the device stops working.
Revoking the device in Settings closes its connection immediately.

**Target session:** a device controls the session set with `companion.setTarget` (Settings →
Companion devices). Without a target it follows the show: the rolling session, else the newest
non-archived one.

## Protocol

`GET /ws/companion` (WebSocket). Auth: `Authorization: Bearer ald_…`, or `?token=ald_…`.
An unknown/revoked token or an inactive user gets HTTP 401 at upgrade.

Server → device (`CompanionServerMessage` in `packages/contract/src/ws.ts`):

- `{ type: 'state', state: CompanionState, serverTime }` — on connect and whenever the target
  session's transport or events, the show's buttons, or the device's target change (debounced
  ~50 ms). `CompanionState` = device, show, target session transport (`isRolling`,
  `rollStartedAt`, `elapsedFrames`, `take`, `frameRate`, `startOffsetFrames`, `eventCount`),
  categories, last event. Clients compute the running timecode locally from the transport and
  `serverTime` (clock offset).
- `{ type: 'result', reqId, ok, data | error }` — reply to an `op`.
- `{ type: 'pong' }`.

Device → server:

- `{ type: 'op', reqId, op, input }` — only `COMPANION_OPS`: `companion.state`,
  `transport.start`, `transport.stop`, `events.create`. For transport and events ops a missing
  `input.sessionId` is filled with the device's current target session. Ops run through the
  normal ops registry (surface `companion`), so writes are attributed `via = 'companion'` with
  the device name, and events get `source = 'companion'`.
- `{ type: 'ping' }`.

Close codes: `4401` unauthenticated, `4403` revoked / access lost. The server pings every 25 s and
updates the device's `last_seen_at` on connect and every few minutes.

### Web ops

| op                                                      | access |                                                                                      |
| ------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `companion.list` `{ showId? }`                          | manage | devices of a show, or of all shows you manage; `online` = connected to this instance |
| `companion.create` `{ showId, name }`                   | manage | returns `{ device, token }` — token shown once                                       |
| `companion.revoke` `{ deviceId }`                       | manage | closes open sockets                                                                  |
| `companion.setTarget` `{ deviceId, sessionId \| null }` | write  | session must be in the device's show                                                 |

## Development

- Unit tests: `npm test -w companion-module-autologger` (state → variables, timecode ticking).
- End-to-end against a dev server with `DEV_LOGIN=1`:
  `node apps/companion/scripts/smoke.mjs http://localhost:8787` (raw protocol) and, after a build,
  `node apps/companion/scripts/connection-check.mjs http://localhost:8787` (the module's client).
