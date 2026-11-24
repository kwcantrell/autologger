import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { subscribe } from '../core/bus.ts';
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

  it('splits before a phrase (atText) or at a time (atSec)', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner, 'Claude Code');
    const [a] = await seed(session.id, [
      {
        start: 10,
        end: 16,
        speaker: 'Tom',
        words: [
          ['How', 10, 10.5],
          ['was', 10.5, 11],
          ['it?', 11, 11.5],
          ['It', 12, 12.5],
          ['was', 12.5, 13],
          ['great,', 13, 14],
          ['honestly.', 14, 16],
        ],
      },
    ]);
    // "was" occurs twice; "how" starts the segment; "nope" is absent.
    for (const atText of ['was', 'How was', 'nope'])
      await failsWith(
        call(agent, 'transcript.splitSegment', { segmentId: a!, atText }),
        'bad_request',
      );
    await failsWith(
      call(agent, 'transcript.splitSegment', { segmentId: a!, atText: 'it', atWord: 3 }),
      'bad_request',
    );

    const [q, ans] = await call(agent, 'transcript.splitSegment', {
      segmentId: a!,
      atText: 'it WAS great',
      speaker: 'Guest',
    });
    expect(q).toMatchObject({ id: a, endSec: 12, speaker: 'Tom', text: 'How was it?' });
    expect(ans).toMatchObject({ startSec: 12, speaker: 'Guest', text: 'It was great, honestly.' });

    const [, tail] = await call(agent, 'transcript.splitSegment', {
      segmentId: ans!.id,
      atSec: 13.5,
    });
    expect(tail).toMatchObject({ startSec: 14, endSec: 16, text: 'honestly.' });
    await failsWith(
      call(agent, 'transcript.splitSegment', { segmentId: tail!.id, atSec: 14 }),
      'bad_request',
    );
  });
});

describe('transcript.renameSpeaker', () => {
  it('relabels a time range, with or without `from`, and undo restores it', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner, 'Claude Code');
    await seed(session.id, [
      { start: 0, end: 20, speaker: 'Speaker 2', words: [['Promo', 0, 20]] },
      { start: 20, end: 47, speaker: 'Speaker 3', words: [['music', 20, 47]] },
      { start: 47, end: 60, speaker: 'Speaker 2', words: [['Welcome', 47, 60]] },
      { start: 60, end: 70, speaker: 'Speaker 1', words: [['Thanks', 60, 70]] },
      { start: 70, end: 80, speaker: 'Speaker 2', words: [['Sure', 70, 80]] },
    ]);
    const before = await call(owner, 'transcript.get', { sessionId: session.id });
    const speakers = async () =>
      (await call(owner, 'transcript.get', { sessionId: session.id })).map((s) => s.speaker);

    expect(
      await call(agent, 'transcript.renameSpeaker', {
        sessionId: session.id,
        from: 'Speaker 2',
        to: 'Promo',
        toSec: 47,
      }),
    ).toEqual({ updated: 1 });
    expect(await speakers()).toEqual(['Promo', 'Speaker 3', 'Speaker 2', 'Speaker 1', 'Speaker 2']);

    expect(
      await call(agent, 'transcript.renameSpeaker', {
        sessionId: session.id,
        to: 'Promo',
        fromSec: 0,
        toSec: 47,
      }),
    ).toEqual({ updated: 1 });
    expect(await speakers()).toEqual(['Promo', 'Promo', 'Speaker 2', 'Speaker 1', 'Speaker 2']);

    // A whole-session rename records one change per segment but publishes each message once.
    const sent: string[] = [];
    const stop = subscribe(`session:${session.id}`, (m) => sent.push(JSON.stringify(m)));
    expect(
      await call(agent, 'transcript.renameSpeaker', {
        sessionId: session.id,
        from: 'Speaker 2',
        to: 'Guest',
      }),
    ).toEqual({ updated: 2 });
    stop();
    expect(await speakers()).toEqual(['Promo', 'Promo', 'Guest', 'Speaker 1', 'Guest']);
    expect(sent.sort()).toEqual(
      [
        { type: 'invalidate', entity: 'change' },
        { type: 'invalidate', entity: 'transcript_segment' },
      ]
        .map((m) => JSON.stringify(m))
        .sort(),
    );

    // Without a range `from` is required, and the range must not be reversed.
    await failsWith(
      call(agent, 'transcript.renameSpeaker', { sessionId: session.id, to: 'X' }),
      'bad_request',
    );
    await failsWith(
      call(agent, 'transcript.renameSpeaker', {
        sessionId: session.id,
        to: 'X',
        fromSec: 50,
        toSec: 10,
      }),
      'bad_request',
    );
    const stranger = await makeUser('stranger@example.com');
    await failsWith(
      call(stranger, 'transcript.renameSpeaker', { sessionId: session.id, from: 'A', to: 'B' }),
      'not_found',
    );

    await undoAll(owner, session.id);
    expect(await call(owner, 'transcript.get', { sessionId: session.id })).toEqual(before);
  });
});

describe('"@seconds" segment refs (#377)', () => {
  it('edit tools accept the starts transcript.text prints in place of ids', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    const [a, b] = await seed(session.id, [
      { start: 0, end: 2.5, speaker: 'Dana', words: [['one', 0, 2.5]] },
      { start: 2.54, end: 5, speaker: 'Dana', words: [['tow', 2.54, 5]] },
      {
        start: 5,
        end: 9,
        speaker: 'Dana',
        words: [
          ['three', 5, 6],
          ['Tom', 6, 7],
          ['four', 7, 9],
        ],
      },
    ]);
    const { text } = await call(agent, 'transcript.text', {
      sessionId: session.id,
      format: 'compact',
      stampEverySec: 0,
    });
    expect(text).toBe('@0.0 Dana: one [@2.5] tow [@5.0] three Tom four');

    const sessionId = session.id;
    expect(
      await call(agent, 'transcript.updateSegments', {
        sessionId,
        updates: [{ segmentId: '@2.5', text: 'two' }],
      }),
    ).toEqual({ updated: 1, ids: [b] });
    // Refs need the session; an unknown start is not_found; ref and id of one segment clash.
    await failsWith(
      call(agent, 'transcript.updateSegment', { segmentId: '@0', text: 'x' }),
      'bad_request',
    );
    await failsWith(
      call(agent, 'transcript.updateSegments', {
        sessionId,
        updates: [{ segmentId: '@1.0', text: 'x' }],
      }),
      'not_found',
    );
    await failsWith(
      call(agent, 'transcript.updateSegments', {
        sessionId,
        updates: [
          { segmentId: '@0', text: 'x' },
          { segmentId: a!, text: 'y' },
        ],
      }),
      'bad_request',
    );
    // An id from another session than the one given is not_found.
    const other = await call(owner, 'sessions.create', { showId: session.showId, title: 'Other' });
    await failsWith(
      call(agent, 'transcript.updateSegment', { sessionId: other.id, segmentId: a!, text: 'x' }),
      'not_found',
    );

    const [, second] = await call(agent, 'transcript.splitSegment', {
      sessionId,
      segmentId: '@5',
      atText: 'Tom',
      speaker: 'Tom',
    });
    expect(second!.startSec).toBe(6);
    const merged = await call(agent, 'transcript.mergeSegments', {
      sessionId,
      segmentIds: ['@0.0', '@2.5'],
    });
    expect(merged).toMatchObject({ id: a, text: 'one two' });
    await call(agent, 'transcript.updateSegment', {
      sessionId,
      segmentId: '@6.0',
      text: 'Tom: four',
    });
    expect((await call(agent, 'transcript.get', { sessionId })).map((s) => s.text)).toEqual([
      'one two',
      'three',
      'Tom: four',
    ]);

    // Two segments starting in the same tenth of a second make the ref ambiguous.
    await seed(session.id, [
      { start: 20.01, end: 21, speaker: 'Dana', words: [['x', 20.01, 21]] },
      { start: 20.04, end: 21, speaker: 'Tom', words: [['y', 20.04, 21]] },
    ]);
    await failsWith(
      call(agent, 'transcript.updateSegments', {
        sessionId,
        updates: [{ segmentId: '@20.0', text: 'z' }],
      }),
      'bad_request',
    );
  });
});
