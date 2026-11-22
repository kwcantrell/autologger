import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { listenForRemote } from './core/bus.ts';
import { loadOps } from './core/op.ts';
import { db } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { env } from './env.ts';
import { createApp } from './http/app.ts';
import { backfillWikiLinks } from './ops/wiki.ts';
import { attachWebSockets } from './ws/upgrade.ts';
import './ws/session.ts';
import './ws/show.ts';
import './ws/companion.ts';
import './mcp/index.ts';

await runMigrations();
// Index [[links]] of wiki pages saved before the link index existed (one query when none are).
const wikiIndexed = await backfillWikiLinks(db);
console.log(`wiki link index: backfilled ${wikiIndexed} pages`);
await loadOps();
await listenForRemote();

const app = createApp();
const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`autologger listening on :${info.port} (public ${env.publicUrl})`);
}) as Server;
attachWebSockets(server);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
