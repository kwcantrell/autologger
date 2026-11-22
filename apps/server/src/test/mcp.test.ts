import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import type { Actor } from '../core/op.ts';
import { db, schema } from '../db/client.ts';
import { createMcpServer } from '../mcp/server.ts';
import { asAgent, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

async function connect(actor: Actor) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(actor).connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    return { isError: !!res.isError, text: res.content.map((c) => c.text).join('\n') };
  };
}

describe('MCP tolerance for stale client tool lists', () => {
  it('coerces "true" and numeric strings where the schema wants booleans and numbers', async () => {
    const { owner, session } = await studio();
    await db.insert(schema.transcriptSegments).values(
      [0, 10, 20].map((s) => ({
        id: newId('seg'),
        sessionId: session.id,
        startSec: s,
        endSec: s + 120,
        speaker: 'Dana',
        text: 'A long turn.',
        words: [],
      })),
    );
    const callTool = await connect(asAgent(owner));

    const found = await callTool('transcript_find', {
      sessionId: session.id,
      suspect: 'true',
      limit: '2',
    });
    expect(found.isError).toBe(false);
    expect(JSON.parse(found.text)).toMatchObject({ total: 3, lines: [{}, {}] });

    // Nested: numbers inside array items; a string field that looks numeric stays a string.
    const created = await callTool('events_createMany', {
      sessionId: session.id,
      events: [{ category: 'Note', atSec: '12.5', value: '42' }],
    });
    expect(created.isError).toBe(false);
    const [event] = JSON.parse(created.text);
    expect(event.atSec).toBe(12.5);
    expect(event.value).toBe('42');
  });

  it('hints at a stale tool list only when a sent value has the wrong type', async () => {
    const { owner, session } = await studio();
    const callTool = await connect(asAgent(owner));

    const stale = await callTool('transcript_find', { sessionId: session.id, suspect: 'yes' });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/^bad_request: .*\n- suspect: /);
    expect(stale.text).toContain("newer than your client's tool list");

    const plain = await callTool('transcript_find', { sessionId: session.id });
    expect(plain.isError).toBe(true);
    expect(plain.text).not.toContain('tool list');
  });
});
