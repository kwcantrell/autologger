---
title: Architecture
section: developers
order: 50
description: How AutoLogger fits together — the ops registry behind HTTP, MCP and Companion, the change log and undo, realtime, timecode, media and dashboards.
---

This page follows [ARCHITECTURE.md](https://github.com/kwcantrell/autologger/blob/main/ARCHITECTURE.md)
in the repository, which contributors read first. When the two disagree, the repository file wins.

## The product in one paragraph

Operators log events against running timecode during a live session (hotkeys 1–9, transport,
Bitfocus Companion hardware). Audio is recorded or imported (local file, YouTube) and transcribed
by Deepgram. **The app itself never calls an LLM.** External agents (Claude Code, claude.ai,
Claude Desktop, any MCP client) connect over MCP and create topics, events, dashboards and wiki
pages, acting as the user who authorised them. Every agent write applies immediately, is recorded
in the change log, and can be undone from the session's **Agents** tab.

## Stack

| Area               | Choice                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Language / runtime | TypeScript, Node ≥ 22, npm workspaces. The server runs on Node's type stripping; only the web app is built                            |
| Server             | Hono on `@hono/node-server`, WebSockets via `ws`                                                                                      |
| Web                | Vite + React 19 SPA, Tailwind v4, shadcn-style primitives on `@base-ui/react`, TanStack Query, wouter                                 |
| Database           | Postgres 17+, Drizzle ORM and drizzle-kit migrations. Authorization lives in the ops layer (no row-level security)                    |
| Auth (people)      | Google OAuth, database-backed session cookie. The instance admin approves new sign-ups. `DEV_LOGIN=1` enables a dev-only email login  |
| Auth (agents)      | An OAuth 2.1 authorization server (dynamic client registration, PKCE, refresh) and personal access tokens. Both act as the user       |
| Auth (Companion)   | Device tokens created in Settings, bound to a user and a show                                                                         |
| Tenancy            | Teams → shows → sessions. Team roles `owner` / `admin` / `member`; members reach shows only through grants; owners and admins see all |
| Media              | S3-compatible object storage (SeaweedFS in compose) through presigned URLs                                                            |
| Transcription      | Deepgram pre-recorded (batch), run by the worker                                                                                      |
| Jobs               | A Postgres `jobs` table, claimed with `FOR UPDATE SKIP LOCKED`                                                                        |
| Realtime           | An in-process bus plus Postgres `LISTEN/NOTIFY`, so worker writes reach WebSocket clients                                             |
| Deploy             | Docker Compose on one host: `app`, `worker`, `postgres`, `s3` (SeaweedFS), `caddy`                                                    |

## Layout

```
packages/contract   Zod schemas + types shared by server, web and companion:
                    entities, op inputs, dashboard spec, WS messages, timecode math
apps/server         HTTP/WS/MCP server and the worker (same codebase, two entrypoints)
  src/db            Drizzle schema, client, migrations
  src/core          ops registry, actor, authz, change log, bus, errors
  src/ops           one file per domain: teams, shows, sessions, events, transport,
                    transcript, topics, dashboards, wiki, media, search, changes, admin, tokens
  src/http          Hono app: auth routes, /api/rpc/:op, exports, static SPA
  src/ws            session WebSocket + companion WebSocket
  src/mcp           MCP server (tools generated from the ops registry) + OAuth AS
  src/worker        job runner: transcribe, youtube import, waveforms, compilations
apps/web            the SPA (this documentation is part of it, from docs/)
apps/companion      Bitfocus Companion module (WebSocket client)
apps/importer       the local import helper (autologger-import)
```

## The ops registry (the core idea)

Every capability is one **op**: a name, a description written for both humans and agents, a Zod
input schema, a kind (`read` / `write`), the surfaces it is exposed on, and a `run(ctx, input)`.

```ts
export const createEvent = defineOp({
  name: 'events.create',
  description: 'Log an event in a session …',
  kind: 'write',
  surfaces: ['web', 'mcp', 'companion'],
  input: CreateEventInput,
  async run(ctx, input) { … },
});
```

- **HTTP**: `POST /api/rpc/:name` with JSON input answers `{ ok: true, data }` or
  `{ ok: false, error: { code, message } }`. The web client is a typed wrapper
  (`rpc('events.create', input)`).
- **MCP**: every op with `'mcp'` in `surfaces` becomes a tool (`events.create` → `events_create`),
  its description and JSON Schema straight from the op. See [MCP server](/docs/developers/mcp-server).
- **Companion WebSocket**: ops with `'companion'` in `surfaces`. See
  [Companion protocol](/docs/developers/companion-protocol).
- `ctx` carries `actor` (`{ userId, via: 'web'|'mcp'|'companion'|'worker', clientName, tokenId }`),
  `db` (the transaction), `record()` (change-log writer), `publish()` (realtime, flushed after
  commit) and `afterCommit()` (best-effort slow cleanup such as S3 deletes).
- Long-poll ops (`jobs.list` with `waitSec`) listen on the realtime bus, wait after commit without
  holding a database connection, then run again in a new transaction.
- Authorization is explicit inside `run`, with `requireTeamRole`, `requireShow(ctx, showId,
  'read'|'write')` and `requireSession(ctx, sessionId, 'read'|'write')`. Missing access answers
  `not_found`.
- Errors: `bad_request`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `unavailable`;
  HTTP maps them to 400/401/403/404/409/503.

There are no other REST routes for features. The only non-op routes are sign-in, OAuth, the MCP
transport, file exports, the import helper download and the WebSockets.

## Change log, attribution and undo

Writes to session and show content (`events`, `topics`, `transcript_segments`, `dashboards`,
`wiki_pages`, `categories`) call `ctx.record({ entity, id, before, after, sessionId?, showId })` in
the same transaction. Each change row stores the actor, the surface (`via`), the MCP client name,
the op name and the before/after JSON. `changes.revert` restores `before` (or deletes when
`before` is null) and is itself recorded. The session's Agents tab lists its changes and offers
undo; `/changes` lists the whole show's, including show-level ones (wiki pages, event buttons).

## Realtime

Clients open `/ws/session/:id`. After authorization the server sends `hello`, then pushes
`{ type: 'change', entity, op: 'upsert'|'delete', id, data? }` and `{ type: 'transport', state }`.
The web app applies them to its query cache. The bus publishes in-process and through
`NOTIFY autologger`, so writes from the worker arrive too.

The rail opens `/ws/show/:id` for the active show: job changes and session-list invalidations for
every session of the show. Recorded changes also become a throttled `invalidate` hint, which keeps
`/changes` current.

## Timecode

`sessions` holds the transport: `is_rolling`, `roll_started_at`, `elapsed_frames` (accumulated
while stopped), `take`, `frame_rate`, `start_offset_frames`. Current timecode =
`start_offset + elapsed + (now − roll_started_at) · fps` while rolling. Events store
`timecode_frames` and `wall_time`. All the math lives in `packages/contract/src/timecode.ts`; no
client keeps a clock of its own.

## Media

1. The browser records with MediaRecorder; each segment goes `media.createUpload` → presigned PUT
   → `media.completeUpload` (an `audio_segments` row, then a `transcribe` job).
2. A local file import is the same flow with one segment.
3. YouTube import: `media.importYoutube` enqueues a job; the worker runs `yt-dlp`, uploads to S3,
   then transcribes.
4. The worker's `transcribe` job streams the object from S3 to Deepgram (`nova-3`, diarized) and
   writes `transcript_segments` offset by the segment's session time.
5. Playback: `media.playbackUrl` returns a presigned GET.
6. Video compilations (`compilations.*`): ranges of YouTube-imported sessions; the worker's
   `compile` job downloads just those sections with yt-dlp, re-encodes and joins them with ffmpeg
   into one MP4.

Without `DEEPGRAM_API_KEY` or S3 settings those ops answer `unavailable` and the UI says so.
Configuration, the worker and the job queue are in [Self-hosting](/docs/developers/self-hosting).

## MCP

`POST /mcp` (streamable HTTP, stateless). The bearer token is an OAuth access token or a personal
access token (`alp_…`). Discovery: `/.well-known/oauth-protected-resource`,
`/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize` (the consent page
is in the SPA at `/oauth/consent`), `/oauth/token`. Tokens are random and stored as SHA-256
hashes.

## Dashboards

A dashboard is `{ version: 1, title, widgets: Widget[] }`. Widget types: `stat`, `bar`, `line`,
`pie`, `table`, `timeline`, `markdown`. Each data widget takes either static `data` rows supplied
by the agent or a named `query` over session data. The web app renders specs with its own
components; nothing an agent writes is executed or rendered as HTML.
