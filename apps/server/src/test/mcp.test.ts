import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import type { Actor } from '../core/op.ts';
import { db, schema } from '../db/client.ts';
import { createMcpServer, mcpTools } from '../mcp/server.ts';
import { asAgent, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

async function connectClient(actor: Actor) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(actor).connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

async function connect(actor: Actor) {
  const client = await connectClient(actor);
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
      compact: 'false',
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
    expect(stale.text).toContain(`tool list is now version ${mcpTools().version}`);

    const plain = await callTool('transcript_find', { sessionId: session.id });
    expect(plain.isError).toBe(true);
    expect(plain.text).not.toContain('tool list');
  });
});

describe('MCP input schemas', () => {
  it('emit repeated sub-schemas once under $defs and still coerce through them', async () => {
    const tools = mcpTools().tools;
    const save = tools.find((t) => t.name === 'dashboards_save')!.inputSchema;
    expect(Object.keys(save.$defs as object).sort()).toEqual([
      'DashboardQuery',
      'ValueFormat',
      'WidgetData',
    ]);
    // A def used once is inlined: dashboards_query has no $defs.
    const query = tools.find((t) => t.name === 'dashboards_query')!.inputSchema;
    expect(query.$defs).toBeUndefined();
    expect(JSON.stringify(query)).not.toContain('$ref');

    const { owner, session } = await studio();
    const callTool = await connect(asAgent(owner));
    const res = await callTool('dashboards_save', {
      sessionId: session.id,
      compact: 'true',
      spec: {
        title: 'Overview',
        widgets: [
          {
            id: 'o',
            type: 'line',
            x: 'atSec',
            y: 'count',
            query: { name: 'events_over_time', bucketSec: '60' },
          },
        ],
      },
    });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toEqual({ id: expect.any(String), revision: 1 });
  });
});

describe('MCP tool-list version', () => {
  it('is in serverInfo.version and the instructions', async () => {
    const { owner } = await studio();
    const client = await connectClient(asAgent(owner));
    const version = mcpTools().version;
    expect(version).toMatch(/^[0-9a-f]{8}$/);
    expect(client.getServerVersion()?.version).toMatch(
      new RegExp(`^\\d+\\.\\d+\\.\\d+\\+tools\\.${version}$`),
    );
    expect(client.getInstructions()).toContain(`Tool list version: ${version}.`);
  });
});

describe('transcript_text with no segments', () => {
  it('says whether the transcript is empty, pending or failed', async () => {
    const { owner, session } = await studio();
    const callTool = await connect(asAgent(owner));
    const read = async (args: Record<string, unknown> = {}) => {
      const res = await callTool('transcript_text', { sessionId: session.id, ...args });
      const [text, numbers] = res.text.split('\n');
      return { text, numbers: JSON.parse(numbers!) };
    };

    expect(await read()).toEqual({
      text: '(no transcript yet: the session has no audio to transcribe)',
      numbers: expect.objectContaining({ totalSegments: 0, transcriptStatus: 'none' }),
    });

    const audioId = newId('aud');
    await db.insert(schema.audioSegments).values({
      id: audioId,
      sessionId: session.id,
      ordinal: 1,
      mimeType: 'audio/mp4',
      origin: 'file',
      objectKey: `sessions/${session.id}/${audioId}.m4a`,
      status: 'transcribing',
    });
    const setStatus = (status: 'transcribed' | 'failed') =>
      db.update(schema.audioSegments).set({ status }).where(eq(schema.audioSegments.id, audioId));

    expect((await read()).text).toMatch(/^\(no transcript yet: transcription is queued/);
    await setStatus('failed');
    expect((await read()).text).toMatch(/^\(no transcript: transcription failed/);

    // Transcribed, but no speech (a music-only video): final, not "yet".
    await setStatus('transcribed');
    expect(await read()).toEqual({
      text: '(transcript is empty: no speech detected)',
      numbers: {
        segments: 0,
        chars: 0,
        totalSegments: 0,
        durationSec: 0,
        transcriptStatus: 'done',
      },
    });

    // An empty page of a non-empty transcript is just an empty range.
    await db.insert(schema.transcriptSegments).values({
      id: newId('seg'),
      sessionId: session.id,
      startSec: 5,
      endSec: 8,
      speaker: 'Dana',
      text: 'Hi.',
      words: [],
    });
    expect((await read({ fromSec: 100 })).text).toMatch(/^\(no segments start in this range/);
    expect((await read()).text).toBe('[00:00:05 @5.0s] Dana: Hi.');
  });
});
