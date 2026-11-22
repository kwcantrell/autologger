# AutoLogger — working notes for agents

Read ARCHITECTURE.md first. The rules that keep this codebase clean:

- **One op per capability.** New behaviour = a new op in `apps/server/src/ops/<domain>.ts`
  (`defineOp`) plus its input schema and output type in `packages/contract/src/ops.ts`. Do not
  add bespoke REST routes; HTTP RPC, MCP and Companion all dispatch through the registry. The
  only non-op routes are auth, OAuth, MCP transport, file exports and WebSockets.
- **Authorize inside the op** with `requireShow` / `requireSession` / `requireTeamRole`.
  Missing access answers `not_found`.
- **Record content writes** (`ctx.record`) with before/after snapshots so the change can be
  undone, and **publish** realtime messages with `ctx.publish` (delivered after commit).
- **Op descriptions are agent documentation.** Write them for an LLM reading the MCP tool list:
  units, id sources, side effects.
- **The app never calls an LLM.** AI features are MCP tools used by external agents.
- Server code runs on Node type stripping: erasable TypeScript only (no enums, namespaces or
  parameter properties) and relative imports end in `.ts`.
- Schema changes: edit `apps/server/src/db/schema.ts`, then `npx drizzle-kit generate` in
  `apps/server`. Never edit generated migrations.
- Tests: ops-level tests against real Postgres in `apps/server/src/test`. Keep them lean.
