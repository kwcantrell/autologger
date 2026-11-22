import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { listenForRemote } from './core/bus.ts';
import { loadOps } from './core/op.ts';
import { runMigrations } from './db/migrate.ts';
import { env } from './env.ts';
import { createApp } from './http/app.ts';
import { attachWebSockets } from './ws/upgrade.ts';
import './ws/session.ts';
import './ws/companion.ts';
import './mcp/index.ts';

await runMigrations();
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
