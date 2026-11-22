import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

const atSecs = async (actor: Parameters<typeof call>[0], sessionId: string) =>
  (await call(actor, 'events.list', { sessionId })).map((e) => e.atSec);

describe('session clock changes', () => {
  it('keep events and the recorded clock at the same seconds across a frame rate change', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    expect(session.frameRate).toBe(24);
    await call(owner, 'events.createMany', {
      sessionId: session.id,
      events: [
        { category: 'Laugh', atSec: 600 },
        { category: 'Ad', atSec: 12.5 },
      ],
    });
    await db
      .update(schema.sessions)
      .set({ elapsedFrames: 24 * 700 })
      .where(eq(schema.sessions.id, session.id));

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
    expect(list.map((e) => e.atSec)).toEqual([12.5, 600]);
    expect(list[1]!.timecodeFrames).toBe(30 * 3600 + 30 * 600);

    // One group: the two retimed events and the clock change, undone in one step.
    const [row] = await call(owner, 'changes.list', { sessionId: session.id, grouped: true });
    expect(row).toMatchObject({ entity: 'session', groupSize: 3, via: 'mcp' });
    await failsWith(call(owner, 'changes.revert', { changeId: row!.id }), 'conflict');
    await call(owner, 'changes.revertGroup', { groupId: row!.groupId! });
    const back = await call(owner, 'sessions.get', { sessionId: session.id });
    expect(back).toMatchObject({
      frameRate: 24,
      startOffsetFrames: 24 * 3600,
      elapsedFrames: 24 * 700,
    });
    const restored = await call(owner, 'events.list', { sessionId: session.id });
    expect(restored[1]!.timecodeFrames).toBe(24 * 3600 + 24 * 600);
    expect(restored.map((e) => e.atSec)).toEqual([12.5, 600]);
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
