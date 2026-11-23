---
title: Contributing
section: developers
order: 60
description: Run the dev stack, follow the house rules, test your change and open a pull request.
---

AutoLogger is open source at [github.com/kwcantrell/autologger](https://github.com/kwcantrell/autologger).
Read [Architecture](/docs/developers/architecture) and the repository's
[CLAUDE.md](https://github.com/kwcantrell/autologger/blob/main/CLAUDE.md) first: they hold the
rules that keep the codebase consistent.

## Run it locally

You need Node 22 or newer and Docker.

```bash
git clone https://github.com/kwcantrell/autologger.git && cd autologger
docker compose -f compose.dev.yaml up -d   # Postgres :54329, S3 (SeaweedFS) :9000
cp .env.example .env                       # DEV_LOGIN=1 lets you sign in with any email
npm install
npm run db:migrate
npm run dev:server                         # API on :18081 (migrates on boot)
npm run dev:web                            # SPA on :5173, proxies /api and /ws
npm run dev:worker -w @autologger/server   # transcription + YouTube jobs
```

The worker needs `yt-dlp` on the host for YouTube import. To skip installing it, run the worker in
Docker instead: `docker compose -f compose.dev.yaml --profile worker up -d --build`.

Open `http://localhost:5173` and sign in. The first account becomes the instance admin.
Transcription needs a `DEEPGRAM_API_KEY` in `.env`; without one, uploads still work and are not
transcribed. More on storage and the worker in [Self-hosting](/docs/developers/self-hosting).

## House rules

- **One op per capability.** New behaviour is a new op in `apps/server/src/ops/<domain>.ts`
  (`defineOp`), with its input schema and output type in `packages/contract/src/ops.ts`. The web
  app, MCP and Companion all call ops; don't add bespoke REST routes.
- **Authorize inside the op** with `requireShow`, `requireSession` or `requireTeamRole`. Missing
  access answers `not_found`.
- **Record content writes** with `ctx.record` (before and after) so they can be undone, and
  **publish** realtime messages with `ctx.publish`.
- **Op descriptions are agent documentation.** Write them for an LLM reading the MCP tool list:
  units, where ids come from, side effects.
- **The app never calls an LLM.** AI features are MCP tools used by external agents.
- The server runs on Node's type stripping: erasable TypeScript only (no enums, namespaces or
  parameter properties), and relative imports end in `.ts`.
- Schema changes: edit `apps/server/src/db/schema.ts`, then run `npx drizzle-kit generate` in
  `apps/server`. Never edit generated migrations.
- UI keeps the established look: see `apps/web/DESIGN.md` and the shared primitives in
  `apps/web/src/shared`. The primitives are shadcn/ui components on Base UI (style `base-nova`,
  Tailwind v4); `apps/web/components.json` describes that setup, so the shadcn CLI and its MCP
  server add new primitives under `src/shared/components/ui`. Restyle anything you add to the
  tokens in `DESIGN.md` before using it.

## Tests and checks

```bash
docker exec <postgres> createdb -U autologger autologger_test   # once
npm test            # all workspaces
npm run typecheck
npm run lint        # Biome; npx biome check --write <files> fixes formatting
```

Ops tests run against a real Postgres (`TEST_DATABASE_URL`, default `autologger_test` on :54329).
Keep them lean: the happy path, a permission failure, and undo for content writes. For UI changes,
also run `npx vite build` in `apps/web` and check the page in a browser, at phone width too.

A live Deepgram check (a paid call of well under a cent) is skipped unless you opt in:

```bash
DEEPGRAM_TEST_API_KEY=<key> npm run test:deepgram -w @autologger/server
```

## Pull requests

1. Keep one concern per change, on a branch from an up-to-date `main`
   (`git switch -c <feat|fix|docs|chore|refactor>/<short-name>`).
2. Commit messages follow the history: `<Area>: <imperative summary>`, then a blank line and the
   why. Areas: `Core`, `Web`, `Media`, `MCP`, `Companion`, `Lint`, `Dev`, `Deploy`, `Docs`.
3. Open a pull request against `main`. CI runs lint, typecheck, the tests against Postgres and the
   web and Companion builds.
4. Anything you leave out or find outside your scope becomes its own GitHub issue; the pull
   request's follow-ups link those issues.

## With Claude Code

The plugin marketplace has contributor plugins that walk you through all of this:

```bash
claude plugin marketplace add kwcantrell/autologger-marketplace
claude plugin install autologger-contribute@autologger   # onboarding, workflow, starter tasks, pre-PR check
claude plugin install autologger-dev@autologger          # implementation guides, reviewer agent, guard hooks
```

Then run `/autologger-contribute:start-here` for a guided first tour, or
`/autologger-contribute:first-tasks` for a starter issue.

## Editing these docs

These pages are the Markdown files in the repository's `docs/` folder, built into the web app.
A page is `docs/<section>/<slug>.md` (sections `guide`, `agents`, `developers`) and is published at
`/docs/<section>/<slug>` once it starts with front matter:

```yaml
---
title: Logging a session
section: guide
order: 20
description: One sentence for the sidebar, the home page and search results.
---
```

The sidebar follows section, then `order`, then title; there is no separate navigation file. Link
to other pages with app paths such as `/docs/guide/topics` and to headings with `#heading-slug`.
Plain Markdown, GFM tables and fenced code; no raw HTML. A file without front matter is not
published. Every page has an "Edit this page on GitHub" link at the bottom.
