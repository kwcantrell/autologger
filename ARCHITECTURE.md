# AutoLogger 3 — Architecture

A clean rebuild of AutoLogger. Same product and look, new internals, agent-native from the start.

## Product in one paragraph

Operators log events against running timecode during a live session (hotkeys 1–9, transport,
Bitfocus Companion hardware). Audio is recorded or imported (local file, YouTube) and transcribed
by Deepgram. **The app itself never calls an LLM.** External agents (Claude Code, claude.ai,
Claude Desktop, any MCP client) connect over MCP and create topics, events, dashboards and wiki
pages, acting as the user who authorised them. Every agent write applies immediately, is recorded
in the change log, and can be undone from the session's **Agents** tab.

## Decisions (fixed)

| Area               | Decision                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Language / runtime | TypeScript, Node ≥ 22, npm workspaces                                                                                                    |
| Server             | Hono on `@hono/node-server`, WebSockets via `ws`                                                                                         |
| Web                | Vite + React 19 SPA, Tailwind v4, shadcn-style primitives on `@base-ui/react`, TanStack Query, wouter                                    |
| DB                 | Plain Postgres 17+, Drizzle ORM + drizzle-kit migrations. Authorization lives in the ops layer (no RLS)                                  |
| Auth (humans)      | Google OAuth (arctic), DB-backed session cookie. Instance superadmin approves new sign-ups. `DEV_LOGIN=1` enables a dev-only email login |
| Auth (agents)      | OAuth 2.1 authorization server (DCR + PKCE + refresh) **and** personal access tokens. Both act as the user                               |
| Auth (Companion)   | Device tokens created in Settings, bound to a user + show                                                                                |
| Tenancy            | Teams → Shows → Sessions. Team roles `owner` / `admin` / `member`; members reach shows only via grants; owner/admin see all team shows   |
| Media              | S3-compatible object storage (SeaweedFS in compose) via presigned URLs                                                                   |
| Transcription      | Deepgram pre-recorded (batch), run by the worker                                                                                         |
| Jobs               | Postgres `jobs` table, `FOR UPDATE SKIP LOCKED`                                                                                          |
| Realtime           | In-process bus + Postgres `LISTEN/NOTIFY` so worker writes reach WebSocket clients                                                       |
| Dashboards         | Declarative JSON spec (validated by Zod). No agent code ever runs; markdown rendered without HTML                                        |
| Deploy             | Docker Compose on one host: `app`, `worker`, `postgres`, `s3` (SeaweedFS), `caddy`                                                       |
| Tests              | Lean: ops-layer tests against real Postgres + a few E2E smoke tests                                                                      |

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
  src/worker        job runner: transcribe, youtube import
apps/web            the SPA
apps/companion      Bitfocus Companion module (WebSocket client)
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

- **HTTP**: `POST /api/rpc/:name` with JSON input → `{ ok: true, data }` or
  `{ ok: false, error: { code, message } }`. The web client is a typed wrapper (`rpc('events.create', input)`).
- **MCP**: every op with `'mcp'` in `surfaces` becomes a tool (`events.create` → `events_create`),
  description and JSON Schema straight from the op.
- **Companion WS**: ops with `'companion'` in `surfaces`.
- `ctx` carries `actor` (`{ userId, via: 'web'|'mcp'|'companion'|'worker', clientName, tokenId }`),
  `db` (the transaction), `record()` (change-log writer) and `publish()` (realtime, flushed after commit).
- Authorization is explicit inside `run` via helpers in `core/authz.ts`: `requireTeamRole`,
  `requireShow(ctx, showId, 'read'|'write')`, `requireSession(ctx, sessionId, 'read'|'write')`.
- Errors: `AppError(code, message)`; codes `bad_request`, `unauthenticated`, `forbidden`,
  `not_found`, `conflict`, `unavailable`. HTTP maps to 400/401/403/404/409/503.

## Change log, attribution and undo

Writes to session/show content (`events`, `topics`, `transcript_segments`, `dashboards`,
`wiki_pages`, `categories`) call `ctx.record({ entity, id, before, after, sessionId?, showId })`
in the same transaction. Each change row stores actor, surface (`via`), MCP client name, op name,
before/after JSON. `changes.revert` restores `before` (or deletes when `before` is null) and is
itself recorded. The Agents tab lists changes with `via = 'mcp'` for the session and offers undo.

## Realtime

Clients open `/ws/session/:id`. After authz the server sends `hello` and then pushes
`{ type: 'change', entity, op: 'upsert'|'delete', id, data? }` and `{ type: 'transport', state }`.
The web app applies them to the TanStack Query cache. The bus publishes in-process and via
`NOTIFY autologger`, so writes from the worker arrive too.

## Timecode

`sessions` holds the transport: `is_rolling`, `roll_started_at`, `elapsed_frames` (accumulated
while stopped), `take`, `frame_rate`, `start_offset_frames`. Current timecode =
`start_offset + elapsed + (now − roll_started_at)·fps` while rolling. Events store
`timecode_frames` and `wall_time`. All math lives in `packages/contract/src/timecode.ts`.

## Media

1. Browser records with MediaRecorder; each segment: `media.createUpload` → presigned PUT →
   `media.completeUpload` (creates `audio_segments` row, enqueues `transcribe`).
2. Local file import: same flow with one segment.
3. YouTube import: `media.importYoutube` enqueues a job; worker runs `yt-dlp`, uploads to S3,
   then transcribes.
4. Worker `transcribe`: streams the object from S3 to Deepgram (`nova-3`, diarize, utterances),
   writes `transcript_segments` offset by the segment's session time.
5. Playback: `media.playbackUrl` returns a presigned GET.
6. Queue order (`claimJob`): `run_after`, transcriptions first, `created_at`, `id`. An import's
   transcription gets `run_after` = the import's `created_at`, so it runs before later imports.

Without `DEEPGRAM_API_KEY` / S3 config the ops return `unavailable` and the UI says so.

## MCP

`POST /mcp` (streamable HTTP, stateless). Bearer token = OAuth access token or PAT (`alp_…`).
Discovery: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
`/oauth/register`, `/oauth/authorize` (consent page in the SPA at `/oauth/consent`),
`/oauth/token`. Tokens are random, stored as SHA-256 hashes.

## Dashboards

A dashboard is `{ version: 1, title, widgets: Widget[] }`. Widget types: `stat`, `bar`, `line`,
`pie`, `table`, `timeline`, `markdown`. Each data widget takes either static `data` rows supplied
by the agent or a named `query` over session data. The web renders specs with its own
components; nothing the agent writes is executed or rendered as HTML.

## Deliberately removed

In-app LLM calls, AI SDK / Agent SDK, per-user provider keys, autogenerate worker, AI chat,
OpenBao, multi-slot dev environments, RLS policies, the legacy "studio" model, sandboxed
dashboard code, data migration from autologger-2.
