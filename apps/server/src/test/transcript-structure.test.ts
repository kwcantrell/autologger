import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

type Seg = { start: number; end: number; speaker: string; words: [string, number, number][] };

async function seed(sessionId: string, segs: Seg[]) {
  const rows = segs.map((s) => ({
    id: newId('seg'),
    sessionId,
    startSec: s.start,
    endSec: s.end,
    speaker: s.speaker,
    text: s.words.map(([w]) => w).join(' '),
    words: s.words.map(([w, st, e]) => ({ w, s: st, e })),
  }));
  await db.insert(schema.transcriptSegments).values(rows);
  return rows.map((r) => r.id);
}

async function undoAll(owner: Parameters<typeof call>[0], sessionId: string) {
  const log = await call(owner, 'changes.list', { sessionId, via: 'mcp' });
  for (const c of log.filter((c) => !c.revertOf && !c.revertedAt))
    await call(owner, 'changes.revert', { changeId: c.id });
}

describe('transcript merge and split', () => {
  it('merges a swapped overlapping pair in one call, and undo restores both', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner, 'Claude Code');
    // Deepgram returned the later words first: segment B starts before A but overlaps it.
    const [, a, b] = await seed(session.id, [
      { start: 0, end: 5, speaker: 'Dana', words: [['Intro.', 0, 5]] },
      {
        start: 647,
        end: 650,
        speaker: 'Dana',
        words: [
          ['of', 648, 648.5],
          ['the', 648.5, 649],
          ['week.', 649, 650],
        ],
      },
      {
        start: 645,
        end: 648.2,
        speaker: 'Speaker 2',
        words: [
          ['Guest', 645, 646],
          ['of', 646, 647],
        ],
      },
    ]);
    const before = await call(owner, 'transcript.get', { sessionId: session.id });

    const merged = await call(agent, 'transcript.mergeSegments', { segmentIds: [a!, b!] });
    expect(merged).toMatchObject({
      id: b,
      startSec: 645,
      endSec: 650,
      speaker: 'Speaker 2',
      text: 'Guest of of the week.',
      edited: true,
    });
    expect(merged.words.map((w) => w.s)).toEqual([645, 646, 648, 648.5, 649]);
    expect(await call(owner, 'transcript.get', { sessionId: session.id })).toHaveLength(2);

    await undoAll(owner, session.id);
    expect(await call(owner, 'transcript.get', { sessionId: session.id })).toEqual(before);
  });

  it('only merges adjacent segments and needs write access', async () => {
    const { owner, session } = await studio();
    const [a, , c] = await seed(session.id, [
      { start: 0, end: 2, speaker: 'A', words: [['one', 0, 2]] },
      { start: 3, end: 5, speaker: 'A', words: [['two', 3, 5]] },
      { start: 6, end: 8, speaker: 'A', words: [['three', 6, 8]] },
    ]);
    await failsWith(
      call(owner, 'transcript.mergeSegments', { segmentIds: [a!, c!] }),
      'bad_request',
    );
    const stranger = await makeUser('stranger@example.com');
    await failsWith(
      call(stranger, 'transcript.mergeSegments', { segmentIds: [a!, c!] }),
      'not_found',
    );
    await failsWith(
      call(stranger, 'transcript.splitSegment', { segmentId: a!, atWord: 1 }),
      'not_found',
    );
  });

  it('splits at a word index, and undo restores the original', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner, 'Claude Code');
    const [a] = await seed(session.id, [
      {
        start: 10,
        end: 14,
        speaker: 'Dana',
        words: [
          ['Thanks.', 10, 11],
          ['Glad', 12, 12.5],
          ['to', 12.5, 13],
          ['be', 13, 13.5],
          ['here.', 13.5, 14],
        ],
      },
    ]);
    const before = await call(owner, 'transcript.get', { sessionId: session.id });

    await failsWith(
      call(agent, 'transcript.splitSegment', { segmentId: a!, atWord: 5 }),
      'bad_request',
    );
    const [first, second] = await call(agent, 'transcript.splitSegment', {
      segmentId: a!,
      atWord: 1,
      speaker: 'Guest',
    });
    expect(first).toMatchObject({ id: a, startSec: 10, endSec: 12, text: 'Thanks.' });
    expect(second).toMatchObject({
      startSec: 12,
      endSec: 14,
      speaker: 'Guest',
      text: 'Glad to be here.',
    });
    expect(second!.words).toHaveLength(4);

    await undoAll(owner, session.id);
    expect(await call(owner, 'transcript.get', { sessionId: session.id })).toEqual(before);
  });
});
