import { asc, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

async function seed(sessionId: string, n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: newId('seg'),
    sessionId,
    startSec: i * 10,
    endSec: i * 10 + 9,
    speaker: 'Speaker 1',
    text: `line ${i}`,
    words: [],
  }));
  await db.insert(schema.transcriptSegments).values(rows);
  return rows.map((r) => r.id);
}

const speakers = async (sessionId: string) =>
  (
    await db
      .select({ speaker: schema.transcriptSegments.speaker })
      .from(schema.transcriptSegments)
      .where(eq(schema.transcriptSegments.sessionId, sessionId))
      .orderBy(asc(schema.transcriptSegments.startSec))
  ).map((r) => r.speaker);

describe('change groups', () => {
  it('folds a bulk call into one row and undoes (and redoes) it in one call', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    await seed(session.id, 4);
    await call(agent, 'transcript.renameSpeaker', {
      sessionId: session.id,
      from: 'Speaker 1',
      to: 'Dana',
    });

    const all = await call(owner, 'changes.list', { sessionId: session.id });
    expect(all).toHaveLength(4);
    expect(new Set(all.map((c) => c.groupId)).size).toBe(1);
    const [row] = await call(owner, 'changes.list', { sessionId: session.id, grouped: true });
    expect(row).toMatchObject({ groupSize: 4, groupUndone: 0, revertedAt: null });

    // One entry undone on its own is skipped; the group undo takes the rest.
    await call(owner, 'changes.revert', { changeId: all[0]!.id });
    const undo = await call(owner, 'changes.revertGroup', { groupId: row!.groupId! });
    expect(undo.reverted).toBe(3);
    expect(await speakers(session.id)).toEqual(Array(4).fill('Speaker 1'));
    await failsWith(call(owner, 'changes.revertGroup', { groupId: row!.groupId! }), 'conflict');

    const folded = await call(owner, 'changes.list', { sessionId: session.id, grouped: true });
    expect(folded.map((c) => [c.groupSize ?? 1, c.revertedAt !== null])).toEqual([
      [3, false], // the group undo
      [1, false], // the single undo
      [4, true], // the rename, fully undone
    ]);

    // Undoing the undo group redoes those three segments.
    await call(owner, 'changes.revertGroup', { groupId: undo.groupId });
    expect((await speakers(session.id)).filter((s) => s === 'Dana')).toHaveLength(3);
  });

  it('fails as a whole when an item changed later, and for users without access', async () => {
    const { owner, session } = await studio();
    const [first] = await seed(session.id, 3);
    await call(asAgent(owner), 'transcript.renameSpeaker', {
      sessionId: session.id,
      from: 'Speaker 1',
      to: 'Dana',
    });
    const [rename] = await call(owner, 'changes.list', { sessionId: session.id });
    const groupId = rename!.groupId!;
    await call(owner, 'transcript.updateSegment', { segmentId: first!, text: 'edited later' });

    await failsWith(call(owner, 'changes.revertGroup', { groupId }), 'conflict');
    expect(await speakers(session.id)).toEqual(['Dana', 'Dana', 'Dana']);

    const outsider = await makeUser('outsider@example.com');
    await failsWith(call(outsider, 'changes.revertGroup', { groupId }), 'not_found');
    // Folding needs a scope, so it never windows over the whole log.
    await failsWith(call(owner, 'changes.list', { grouped: true }), 'bad_request');
  });

  it('undoes an item changed twice in one group back to its first state', async () => {
    const { owner, session } = await studio();
    const [seg] = await seed(session.id, 1);
    await call(owner, 'transcript.updateSegment', { segmentId: seg!, text: 'first edit' });
    await call(owner, 'transcript.updateSegment', { segmentId: seg!, text: 'second edit' });
    // No op writes one item twice today; join the two calls into one group to stand in for it.
    const log = await call(owner, 'changes.list', { sessionId: session.id });
    await db
      .update(schema.changes)
      .set({ groupId: log[1]!.groupId })
      .where(eq(schema.changes.id, log[0]!.id));

    expect((await call(owner, 'changes.revertGroup', { groupId: log[1]!.groupId! })).reverted).toBe(
      2,
    );
    const [row] = await db
      .select({ text: schema.transcriptSegments.text })
      .from(schema.transcriptSegments)
      .where(eq(schema.transcriptSegments.id, seg!));
    expect(row!.text).toBe('line 0');
  });

  it('undoes a show-level (category) group', async () => {
    const { owner, show } = await studio();
    const agent = asAgent(owner);
    const before = await call(owner, 'categories.list', { showId: show.id });
    await call(agent, 'categories.save', {
      showId: show.id,
      categories: [
        { id: before[0]!.id, name: 'Chapter', color: '#3B82F6' },
        { name: 'Proof', color: '#22c55e' },
      ],
    });
    const [row] = await call(owner, 'changes.list', { showId: show.id, grouped: true });
    expect(row!.groupSize).toBeGreaterThan(1);
    await call(owner, 'changes.revertGroup', { groupId: row!.groupId! });
    expect((await call(owner, 'categories.list', { showId: show.id })).map((c) => c.name)).toEqual(
      before.map((c) => c.name),
    );
  });

  it('needs write access to every session in the group', async () => {
    const mine = await studio();
    const theirs = await studio();
    await seed(mine.session.id, 2);
    await seed(theirs.session.id, 2);
    const rename = (s: typeof mine) =>
      call(s.owner, 'transcript.renameSpeaker', {
        sessionId: s.session.id,
        from: 'Speaker 1',
        to: 'Dana',
      });
    await rename(mine);
    await rename(theirs);
    // A group that reaches a session the caller cannot write.
    const [own] = await call(mine.owner, 'changes.list', { sessionId: mine.session.id });
    await db
      .update(schema.changes)
      .set({ groupId: own!.groupId })
      .where(eq(schema.changes.sessionId, theirs.session.id));

    const [row] = await call(mine.owner, 'changes.list', {
      sessionId: mine.session.id,
      grouped: true,
    });
    expect(row).toMatchObject({ groupSize: 2, groupTotal: 4 });
    await failsWith(
      call(mine.owner, 'changes.revertGroup', { groupId: own!.groupId! }),
      'not_found',
    );
    expect(await speakers(mine.session.id)).toEqual(['Dana', 'Dana']);
    expect(await speakers(theirs.session.id)).toEqual(['Dana', 'Dana']);
  });
});
