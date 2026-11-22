# AutoLogger

Session-logging workspace for production teams. Operators log events against running timecode
(hotkeys 1–9, transport, Bitfocus Companion hardware), record or import audio, and get Deepgram
transcripts. **AI works through MCP:** connect Claude Code, claude.ai or any MCP client and it can
read sessions and create topics, events, dashboards and wiki pages as you — every agent change is
attributed and undoable from the session's **Agents** tab.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it fits together.

## Quick start (development)

```bash
docker compose -f compose.dev.yaml up -d   # Postgres :54329, S3 (SeaweedFS) :9000
cp .env.example .env                       # DEV_LOGIN=1 lets you sign in with any email
npm install
npm run db:migrate
npm run dev:server                         # API on :8080 (migrates on boot)
npm run dev:web                            # SPA on :5173, proxies /api and /ws
npm run dev:worker -w @autologger/server   # transcription + YouTube jobs
```

Open http://localhost:5173 and sign in. The **first account** becomes the instance admin; later
accounts wait for approval unless they were invited to a team or listed in `SUPERADMIN_EMAILS`.

## Tests

```bash
docker exec <postgres> createdb -U autologger autologger_test   # once
npm test
```

Ops tests run against a real Postgres (`TEST_DATABASE_URL`, default `autologger_test` on :54329).

## Deploy

One host, Docker Compose: app, worker, Postgres, SeaweedFS (S3), Caddy.

```bash
cat > .env <<EOF
PUBLIC_URL=https://autologger.example.com
SITE_ADDRESS=autologger.example.com
POSTGRES_PASSWORD=$(openssl rand -hex 16)
S3_PASSWORD=$(openssl rand -hex 16)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SUPERADMIN_EMAILS=you@example.com
DEEPGRAM_API_KEY=...
EOF
docker compose up -d --build
```

Google OAuth redirect URI: `$PUBLIC_URL/auth/google/callback`.

## Connecting an agent

```bash
claude mcp add --transport http autologger https://autologger.example.com/mcp
```

Claude Code and claude.ai sign in through OAuth; scripts can use a personal access token from
Settings → Agents. Details in [docs/mcp.md](docs/mcp.md).

## Repository

| Path | What |
|---|---|
| `packages/contract` | Shared Zod schemas, entity types, op catalog, dashboard spec, timecode math |
| `apps/server` | API, WebSockets, MCP + OAuth, worker (`src/worker`) |
| `apps/web` | React SPA |
| `apps/companion` | Bitfocus Companion module |
| `docs/` | Feature notes (MCP, media, companion, UI inventory) |
