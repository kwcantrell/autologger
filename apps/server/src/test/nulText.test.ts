// NUL characters in op input (#228): Postgres cannot store U+0000 in text or jsonb, so every op
// refuses it with bad_request naming the field, on every surface.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toRpcError } from '../core/errors.ts';
import { db } from '../db/client.ts';
import { createApp } from '../http/app.ts';
import { createMcpServer } from '../mcp/server.ts';
import { asAgent, call, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

const NUL = '\u0000';

async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return toRpcError(e);
  }
  throw new Error('expected the op to fail');
}

describe('NUL characters in op input', () => {
  it('answer bad_request naming the field, and write nothing', async () => {
    const { owner, show, session } = await studio();
    const cases: [Promise<unknown>, string][] = [
      [
        call(owner, 'events.create', {
          sessionId: session.id,
          category: 'Note',
          message: `nul${NUL}here`,
          atSec: 40,
        }),
        'message',
      ],
      [call(owner, 'topics.create', { sessionId: session.id, startSec: 60, title: NUL }), 'title'],
      [call(owner, 'sessions.update', { sessionId: session.id, notes: `n${NUL}` }), 'notes'],
      [
        call(owner, 'wiki.upsert', { showId: show.id, kind: 'topic', title: 't', bodyMd: NUL }),
        'bodyMd',
      ],
      [
        call(owner, 'events.createMany', {
          sessionId: session.id,
          events: [
            { category: 'Note', message: 'ok', atSec: 42 },
            { category: 'Note', message: `bad${NUL}`, atSec: 43 },
          ],
        }),
        'events[1].message',
      ],
      [call(owner, 'search', { query: `a${NUL}b` }), 'query'],
      [call(owner, 'changes.list', { clientName: `a${NUL}` }), 'clientName'],
    ];
    for (const [p, path] of cases) {
      const err = await rejection(p);
      expect(err).toMatchObject({ code: 'bad_request', issues: [{ path }] });
      expect(err.message).toContain('NUL');
    }
    expect(await call(owner, 'events.list', { sessionId: session.id })).toEqual([]);
  });

  it('answer 400 over HTTP RPC and a bad_request tool error over MCP', async () => {
    const { owner, session } = await studio();
    const { token } = await call(owner, 'tokens.createPat', { name: 'nul' });
    const res = await createApp().request('/api/rpc/events.create', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, category: `N${NUL}`, atSec: 1 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: 'bad_request', issues: [{ path: 'category' }] },
    });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(asAgent(owner)).connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    const out = (await client.callTool({
      name: 'events_create',
      arguments: { sessionId: session.id, category: 'Note', message: `x${NUL}`, atSec: 1 },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/^bad_request: .*NUL[\s\S]*\n- message: /);
  });

  it('map a NUL that reaches Postgres any other way to bad_request', async () => {
    const err = await rejection(db.execute(sql`select ${`a${NUL}b`}::text`));
    expect(err.code).toBe('bad_request');
  });
});
