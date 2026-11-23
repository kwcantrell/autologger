// Events may not lie before the session start timecode (#229): no negative atSec from a
// timecode, a CSV row or a clock change.

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toRpcError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { call, failsWith, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

async function message(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return toRpcError(e).message;
  }
  throw new Error('expected the op to fail');
}

describe('events before the session start', () => {
  it('are refused by create, createMany and update; the start itself is atSec 0', async () => {
    const { owner, session } = await studio(); // 24 fps from 01:00:00:00
    const sessionId = session.id;
    expect(
      await message(
        call(owner, 'events.create', { sessionId, category: 'Note', timecode: '00:59:00:00' }),
      ),
    ).toContain('before the session start timecode 01:00:00:00');
    const ok = await call(owner, 'events.create', {
      sessionId,
      category: 'Note',
      timecode: '01:00:00:00',
    });
    expect(ok.atSec).toBe(0);

    expect(
      await message(
        call(owner, 'events.createMany', {
          sessionId,
          events: [
            { category: 'Note', timecode: '01:00:01:00' },
            { category: 'Note', timecode: '00:00:01:00' },
          ],
        }),
      ),
    ).toMatch(/^events\[1\]: Timecode 00:00:01:00 is before/);
    await failsWith(
      call(owner, 'events.update', { eventId: ok.id, timecode: '00:00:00:00' }),
      'bad_request',
    );
    const list = await call(owner, 'events.list', { sessionId });
    expect(list.map((e) => e.atSec)).toEqual([0]);
  });

  it('are skipped by importCsv with a reason', async () => {
    const { owner, session } = await studio();
    const out = await call(owner, 'events.importCsv', {
      sessionId: session.id,
      csv: '00:00:01:00,Note,early\n01:00:01:00,Note,ok\n',
    });
    expect(out).toEqual({
      imported: 1,
      skipped: [
        { line: 1, reason: 'timecode “00:00:01:00” is before the session start 01:00:00:00' },
      ],
    });
  });

  it('make a clock change that would put events before the start fail, unchanged', async () => {
    const { owner, session } = await studio();
    const sessionId = session.id;
    const ev = await call(owner, 'events.create', { sessionId, category: 'Note', atSec: 10 });

    // keep_frames: the event's timecode 01:00:10:00 would precede the new start.
    expect(
      await message(
        call(owner, 'sessions.update', {
          sessionId,
          startTimecode: '01:00:30:00',
          retime: 'keep_frames',
        }),
      ),
    ).toContain(
      '1 logged event would fall before the start timecode 01:00:30:00 (earliest at atSec -20)',
    );
    expect(await call(owner, 'sessions.get', { sessionId })).toMatchObject({
      startOffsetFrames: 24 * 3600,
    });
    // keep_seconds keeps it at atSec 10.
    await call(owner, 'sessions.update', { sessionId, startTimecode: '01:00:30:00' });
    expect((await call(owner, 'events.list', { sessionId }))[0]).toMatchObject({
      id: ev.id,
      atSec: 10,
    });

    // An event stored before the start by older versions blocks a clock change until moved.
    await db.insert(schema.events).values({
      id: newId('evt'),
      sessionId,
      category: 'Note',
      color: '#a3a3a3',
      timecodeFrames: 24 * 3600,
      source: 'operator',
      createdBy: owner.user.id,
    });
    await failsWith(call(owner, 'sessions.update', { sessionId, frameRate: 25 }), 'bad_request');
  });

  it('stored by older versions are clamped to the start by migration 0021 (#264)', async () => {
    const { owner, session } = await studio(); // 24 fps from 01:00:00:00
    const sessionId = session.id;
    const ok = await call(owner, 'events.create', { sessionId, category: 'Note', atSec: 5 });
    const early = newId('evt');
    await db.insert(schema.events).values({
      id: early,
      sessionId,
      category: 'Note',
      color: '#a3a3a3',
      message: 'kept',
      timecodeFrames: 24 * 3600 - 48, // atSec -2
      source: 'operator',
      createdBy: owner.user.id,
    });
    const migration = new URL('../../drizzle/0021_clamp_events_before_start.sql', import.meta.url);
    for (let i = 0; i < 2; i++) await db.execute(sql.raw(readFileSync(migration, 'utf8')));

    const list = await call(owner, 'events.list', { sessionId });
    expect(list.map((e) => [e.id, e.atSec])).toEqual([
      [early, 0],
      [ok.id, 5],
    ]);
    expect(list[0]).toMatchObject({ message: 'kept', timecodeFrames: 24 * 3600 });
    await call(owner, 'sessions.update', { sessionId, frameRate: 25 });
  });
});
