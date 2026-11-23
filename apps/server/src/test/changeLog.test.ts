import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

describe('show change log', () => {
  it('places session content changes in time and filters by surfaces and MCP client', async () => {
    const { owner, show, session } = await studio();
    const claude = asAgent(owner, 'claude-code');
    const other = asAgent(owner, 'other-agent');
    // The session clock starts at 01:00:00:00: atSec is from the session start, not the timecode.
    const ev = await call(claude, 'events.create', {
      sessionId: session.id,
      category: 'Scene',
      atSec: 12.5,
    });
    await call(other, 'topics.create', { sessionId: session.id, startSec: 30, title: 'Intro' });
    const segId = newId('seg');
    await db.insert(schema.transcriptSegments).values({
      id: segId,
      sessionId: session.id,
      startSec: 42.25,
      endSec: 45,
      speaker: 'Speaker 1',
      text: 'hello',
      words: [],
    });
    await call(owner, 'transcript.updateSegment', { segmentId: segId, text: 'Hello.' });
    await call(owner, 'events.delete', { eventId: ev.id });

    const all = await call(owner, 'changes.list', { showId: show.id, grouped: true });
    const at = (entity: string, kind: string) =>
      all.find((c) => c.entity === entity && c.kind === kind)?.atSec;
    expect(at('event', 'create')).toBe(12.5);
    expect(at('event', 'delete')).toBe(12.5); // from the before snapshot
    expect(at('topic', 'create')).toBe(30);
    expect(at('transcript_segment', 'update')).toBe(42.25);
    expect(all.find((c) => c.entity === 'category')).not.toHaveProperty('atSec');

    // A single via (what MCP clients send), a list, and one MCP client.
    const mcp = await call(owner, 'changes.list', { showId: show.id, via: 'mcp' });
    expect(mcp.map((c) => c.clientName).sort()).toEqual(['claude-code', 'other-agent']);
    const operators = await call(owner, 'changes.list', {
      showId: show.id,
      via: ['web', 'companion'],
    });
    expect(operators.length).toBeGreaterThan(0);
    expect(operators.every((c) => c.via === 'web')).toBe(true);
    const one = await call(owner, 'changes.list', { showId: show.id, clientName: 'claude-code' });
    expect(one.map((c) => [c.entity, c.kind])).toEqual([['event', 'create']]);

    expect((await call(owner, 'shows.get', { showId: show.id })).mcpClients).toEqual([
      'claude-code',
      'other-agent',
    ]);

    // An undo of the delete is placed too (its after snapshot is the restored event).
    const del = all.find((c) => c.entity === 'event' && c.kind === 'delete')!;
    expect((await call(owner, 'changes.revert', { changeId: del.id })).atSec).toBe(12.5);

    const outsider = await makeUser('outsider@example.com');
    await failsWith(call(outsider, 'changes.list', { showId: show.id }), 'not_found');
    await failsWith(call(outsider, 'shows.get', { showId: show.id }), 'not_found');
  });

  it('names the Companion device on its changes and lists devices for the filter', async () => {
    const { owner, show, session } = await studio();
    const { device } = await call(owner, 'companion.create', { showId: show.id, name: 'Booth A' });
    const deck = {
      ...owner,
      via: 'companion' as const,
      clientName: device.name,
      tokenId: device.id,
      device: { id: device.id, showId: show.id, targetSessionId: null },
    };
    await call(deck, 'events.create', { sessionId: session.id, category: 'Scene' });
    await call(asAgent(owner, 'claude-code'), 'topics.create', {
      sessionId: session.id,
      startSec: 1,
      title: 'Intro',
    });

    const got = await call(owner, 'shows.get', { showId: show.id });
    expect(got.mcpClients).toEqual(['claude-code']);
    expect(got.companionDevices).toEqual(['Booth A']);
    const mine = await call(owner, 'changes.list', {
      showId: show.id,
      via: 'companion',
      clientName: 'Booth A',
    });
    expect(mine.map((c) => [c.entity, c.clientName])).toEqual([['event', 'Booth A']]);
  });
});
