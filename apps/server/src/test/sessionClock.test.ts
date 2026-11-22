import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

type Actor = Parameters<typeof call>[0];
const atSecs = async (actor: Actor, sessionId: string) =>
  (await call(actor, 'events.list', { sessionId })).map((e) => e.atSec);
const setElapsed = (sessionId: string, elapsedFrames: number) =>
  db.update(schema.sessions).set({ elapsedFrames }).where(eq(schema.sessions.id, sessionId));
const lastGroup = async (actor: Actor, sessionId: string) =>
  (await call(actor, 'changes.list', { sessionId, grouped: true }))[0]!;

describe('session clock changes', () => {
  it('keep events and the recorded clock at the same seconds; undo restores the frames', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    expect(session.frameRate).toBe(24);
    const [, , untimed] = await call(owner, 'events.createMany', {
      sessionId: session.id,
      events: [
        { category: 'Laugh', atSec: 600 },
        { category: 'Ad', atSec: 12.5 },
        { category: 'Note', atSec: 1 },
      ],
    });
    await db
      .update(schema.events)
      .set({ timecodeFrames: null })
      .where(eq(schema.events.id, untimed!.id));
    await setElapsed(session.id, 24 * 700);

    const s = await call(agent, 'sessions.update', {
      sessionId: session.id,
      frameRate: 30,
      startTimecode: '01:00:00:00',
    });
    expect(s).toMatchObject({
      frameRate: 30,
      startOffsetFrames: 30 * 3600,
      elapsedFrames: 30 * 700,
    });
    const list = await call(owner, 'events.list', { sessionId: session.id });
    expect(list.map((e) => e.atSec)).toEqual([12.5, 600, null]);
    expect(list[1]!.timecodeFrames).toBe(30 * 3600 + 30 * 600);

    // One group: the two timed events and the clock change, undone together only.
    const row = await lastGroup(owner, session.id);
    expect(row).toMatchObject({ entity: 'session', groupSize: 3, via: 'mcp' });
    await failsWith(call(owner, 'changes.revert', { changeId: row.id }), 'conflict');
    const all = await call(owner, 'changes.list', { groupId: row.groupId! });
    const eventChange = all.find((c) => c.entity === 'event')!;
    await failsWith(call(owner, 'changes.revert', { changeId: eventChange.id }), 'conflict');

    await call(owner, 'changes.revertGroup', { groupId: row.groupId! });
    expect(await call(owner, 'sessions.get', { sessionId: session.id })).toMatchObject({
      frameRate: 24,
      startOffsetFrames: 24 * 3600,
      elapsedFrames: 24 * 700,
    });
    const restored = await call(owner, 'events.list', { sessionId: session.id });
    expect(restored[1]!.timecodeFrames).toBe(24 * 3600 + 24 * 600);
    expect(restored.map((e) => e.atSec)).toEqual([12.5, 600, null]);
  });

  it('keep atSec when the start timecode changes, unless retime is keep_frames', async () => {
    const { owner, session } = await studio();
    await call(owner, 'events.create', { sessionId: session.id, category: 'Laugh', atSec: 600 });

    await call(owner, 'sessions.update', { sessionId: session.id, startTimecode: '10:00:00:00' });
    expect(await atSecs(owner, session.id)).toEqual([600]);
    const [e] = await call(owner, 'events.list', { sessionId: session.id });
    expect(e!.timecodeFrames).toBe(24 * 36000 + 24 * 600);

    // keep_frames keeps the stored frames: the event moves by the offset difference (1 h).
    await call(owner, 'sessions.update', {
      sessionId: session.id,
      startTimecode: '09:00:00:00',
      retime: 'keep_frames',
    });
    expect(await atSecs(owner, session.id)).toEqual([4200]);
  });

  it('keep the start timecode when only the frame rate changes', async () => {
    const { owner, session } = await studio();
    await call(owner, 'events.create', { sessionId: session.id, category: 'Laugh', atSec: 600 });
    const s = await call(owner, 'sessions.update', { sessionId: session.id, frameRate: 30 });
    expect(s).toMatchObject({ frameRate: 30, startOffsetFrames: 30 * 3600 });
    expect(await atSecs(owner, session.id)).toEqual([600]);
    const row = await lastGroup(owner, session.id);
    await call(owner, 'changes.revertGroup', { groupId: row.groupId! });
    expect(await call(owner, 'sessions.get', { sessionId: session.id })).toMatchObject({
      frameRate: 24,
      startOffsetFrames: 24 * 3600,
    });

    // :29 does not exist at 24 fps: ask for an explicit start timecode.
    await call(owner, 'sessions.update', {
      sessionId: session.id,
      frameRate: 30,
      startTimecode: '01:00:00:29',
    });
    await failsWith(
      call(owner, 'sessions.update', { sessionId: session.id, frameRate: 24 }),
      'bad_request',
    );
    const t = await call(owner, 'sessions.update', {
      sessionId: session.id,
      frameRate: 24,
      startTimecode: '01:00:00:23',
    });
    expect(t.startOffsetFrames).toBe(24 * 3600 + 23);
  });

  it('undo restores elapsed frames exactly, and refuses while rolling or after new events', async () => {
    const { owner, session } = await studio();
    await setElapsed(session.id, 1);
    // 1 frame at 24 fps rounds to 0 at 10 fps; undo brings back exactly 1.
    await call(owner, 'sessions.update', { sessionId: session.id, frameRate: 10 });
    const first = await lastGroup(owner, session.id);
    await call(owner, 'transport.start', { sessionId: session.id });
    await failsWith(call(owner, 'changes.revertGroup', { groupId: first.groupId! }), 'conflict');
    await call(owner, 'transport.stop', { sessionId: session.id });
    await setElapsed(session.id, 0);
    await call(owner, 'changes.revertGroup', { groupId: first.groupId! });
    expect((await call(owner, 'sessions.get', { sessionId: session.id })).elapsedFrames).toBe(1);

    await call(owner, 'sessions.update', { sessionId: session.id, frameRate: 30 });
    const second = await lastGroup(owner, session.id);
    await call(owner, 'events.create', { sessionId: session.id, category: 'Laugh', atSec: 5 });
    await failsWith(call(owner, 'changes.revertGroup', { groupId: second.groupId! }), 'conflict');
  });

  it('serialise event writes with a clock change', async () => {
    const { owner, session } = await studio();
    let settled = false;
    let pending: Promise<{ timecodeFrames: number | null }> | undefined;
    // Hold the session row the way sessions.update does while an event is logged.
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, session.id))
        .for('update');
      pending = call(owner, 'events.create', {
        sessionId: session.id,
        category: 'Laugh',
        atSec: 600,
      }).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await tx
        .update(schema.sessions)
        .set({ frameRate: 30, startOffsetFrames: 30 * 3600 })
        .where(eq(schema.sessions.id, session.id));
    });
    // Resolved against the new clock once the change committed.
    expect((await pending!).timecodeFrames).toBe(30 * 3600 + 30 * 600);
  });

  it('retime and undo thousands of events in bulk', async () => {
    const { owner, session } = await studio();
    await db.insert(schema.events).values(
      Array.from({ length: 3000 }, (_, i) => ({
        id: newId('evt'),
        sessionId: session.id,
        category: 'Laugh',
        color: '#fff',
        source: 'import' as const,
        timecodeFrames: 24 * 3600 + i * 24,
      })),
    );
    const t0 = Date.now();
    await call(owner, 'sessions.update', { sessionId: session.id, frameRate: 29.97 });
    const row = await lastGroup(owner, session.id);
    // The start timecode stays 01:00:00:00, so every event is retimed: 3000 events plus the clock.
    expect(row.groupSize).toBe(3001);
    const undo = await call(owner, 'changes.revertGroup', { groupId: row.groupId! });
    // Redo (undo of the undo), then undo again.
    await call(owner, 'changes.revertGroup', { groupId: undo.groupId });
    expect((await call(owner, 'sessions.get', { sessionId: session.id })).frameRate).toBe(29.97);
    // Within one frame at 29.97 fps.
    expect((await atSecs(owner, session.id))[2999]).toBeCloseTo(2999, 1);
    const redo = await lastGroup(owner, session.id);
    await call(owner, 'changes.revertGroup', { groupId: redo.groupId! });
    expect(Date.now() - t0).toBeLessThan(8000);
    const list = await call(owner, 'events.list', { sessionId: session.id });
    expect(list[2999]!.timecodeFrames).toBe(24 * 3600 + 2999 * 24);
    expect(list[2999]!.atSec).toBe(2999);
  });

  it('need write access and a stopped transport', async () => {
    const { owner, session } = await studio();
    const outsider = asAgent(await makeUser('outsider@example.com'));
    await failsWith(
      call(outsider, 'sessions.update', { sessionId: session.id, frameRate: 30 }),
      'not_found',
    );
    await call(owner, 'transport.start', { sessionId: session.id });
    await failsWith(
      call(owner, 'sessions.update', { sessionId: session.id, frameRate: 30 }),
      'conflict',
    );
  });
});
