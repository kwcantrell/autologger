import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities, OpName } from '@autologger/contract';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTP_STATUS, toRpcError } from '../core/errors.ts';
import { type Actor, executeOp } from '../core/op.ts';
import {
  env,
  googleConfigured,
  isProd,
  storageConfigured,
  transcriptionConfigured,
} from '../env.ts';
import { actorFromBearer } from '../mcp/tokens.ts';
import { actorFromSessionToken, authRoutes, SESSION_COOKIE } from './auth.ts';
import { exportRoutes } from './exports.ts';

type Env = { Variables: { actor: Actor | null } };

/** Where the import helper is downloaded from (docs/importer.md). */
export const IMPORTER_ROUTE = '/api/importer/autologger-import.mjs';

/** Extra route groups registered by feature modules (MCP, OAuth). */
const extraRoutes: Hono[] = [];
export function registerRoutes(routes: Hono): void {
  extraRoutes.push(routes);
}

export function bearerFrom(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return m?.[1]?.trim();
}

export function createApp(): Hono<Env> {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    await next();
  });

  // Resolve the caller once per request: browser cookie, else agent bearer token.
  app.use('/api/*', async (c, next) => {
    let actor = await actorFromSessionToken(getCookie(c, SESSION_COOKIE));
    const bearer = bearerFrom(c.req.header('authorization'));
    if (!actor && bearer) actor = await actorFromBearer(bearer);
    c.set('actor', actor);
    await next();
  });

  app.route('/', authRoutes);
  for (const r of extraRoutes) app.route('/', r);

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/api/capabilities', (c) =>
    c.json({
      ok: true,
      data: {
        googleAuth: googleConfigured,
        devLogin: env.devLogin && !isProd,
        storage: storageConfigured,
        transcription: transcriptionConfigured,
        youtube: env.youtubeEnabled && storageConfigured,
        publicUrl: env.publicUrl,
        landingPage: env.landingPage,
        docsUrl: env.docsUrl,
      } satisfies Capabilities,
    }),
  );

  app.post('/api/rpc/:op', async (c) => {
    const actor = c.get('actor');
    if (!actor) {
      return c.json(
        { ok: false, error: { code: 'unauthenticated', message: 'Sign in first.' } },
        401,
      );
    }
    const input = await c.req.json().catch(() => ({}));
    // Bearer callers (agents using plain HTTP) get the MCP surface; browsers get the web surface.
    const surface = actor.via === 'mcp' ? 'mcp' : 'web';
    try {
      const data = await executeOp(
        c.req.param('op') as OpName,
        input,
        actor,
        surface,
        c.req.raw.signal,
      );
      return c.json({ ok: true, data });
    } catch (e) {
      const error = toRpcError(e);
      return c.json({ ok: false, error }, HTTP_STATUS[error.code]);
    }
  });

  app.route('/', exportRoutes);

  // The local import helper (apps/importer) as one dependency-free file: `node
  // autologger-import.mjs …` on the user's computer. A file download, not an op; no sign-in needed.
  app.get(IMPORTER_ROUTE, async (c) => {
    const body = await readFile(env.importerFile).catch(() => null);
    if (!body)
      return c.json(
        { ok: false, error: { code: 'not_found', message: 'The import helper is not bundled.' } },
        404,
      );
    return c.body(body, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Disposition': 'attachment; filename="autologger-import.mjs"',
      'Cache-Control': 'no-cache',
    });
  });

  app.all('/api/*', (c) =>
    c.json({ ok: false, error: { code: 'not_found', message: 'No such endpoint.' } }, 404),
  );

  // Built SPA (production): static assets, then index.html for client routes.
  if (env.webDist && existsSync(env.webDist)) {
    const indexHtml = readFileSync(join(env.webDist, 'index.html'), 'utf8');
    app.use(
      '/assets/*',
      serveStatic({
        root: env.webDist,
        onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable'),
      }),
    );
    app.use('*', serveStatic({ root: env.webDist }));
    app.get('*', (c) => c.html(indexHtml));
  }

  return app;
}
