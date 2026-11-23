import type { OpInput, TranscriptFindLine } from '@autologger/contract';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import type { Actor } from '../core/op.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

/** transcript.find's matched (and context) lines, without the total. */
async function findLines(actor: Actor, input: OpInput<'transcript.find'>) {
  const res = await call(actor, 'transcript.find', input);
  if (!('lines' in res)) throw new Error('expected lines');
  return res.lines as TranscriptFindLine[];
}

async function seedTranscript(sessionId: string, lines: string[]) {
  const rows = lines.map((text, i) => ({
    id: newId('seg'),
    sessionId,
    startSec: i * 10,
    endSec: i * 10 + 9,
    speaker: 'Speaker 1',
    text,
    words: text.split(' ').map((w, j) => ({ w, s: i * 10 + j, e: i * 10 + j + 1 })),
  }));
  await db.insert(schema.transcriptSegments).values(rows);
  return rows.map((r) => r.id);
}

describe('transcript find and batch update', () => {
  it('finds lines by text or regex and fixes them in one undoable call', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner, 'Claude Code');
    const [a, b, c] = await seedTranscript(session.id, [
      'Ask Doctor Smith about x2',
      'nothing to see here',
      'the doctor said 50% off',
    ]);

    const plain = await findLines(agent, {
      sessionId: session.id,
      pattern: 'DOCTOR',
    });
    expect(plain.map((l) => l.id)).toEqual([a, c]);
    expect(plain[0]).not.toHaveProperty('words');
    expect(await findLines(agent, { sessionId: session.id, pattern: '50%' })).toHaveLength(1);
    expect(
      (
        await findLines(agent, {
          sessionId: session.id,
          pattern: '\\mx2\\M',
          regex: true,
        })
      ).map((l) => l.id),
    ).toEqual([a]);
    await failsWith(
      call(agent, 'transcript.find', { sessionId: session.id, pattern: '(', regex: true }),
      'bad_request',
    );

    const res = await call(agent, 'transcript.updateSegments', {
      sessionId: session.id,
      updates: [
        { segmentId: a!, text: 'Ask Dr Smith about x squared' },
        { segmentId: b!, text: 'nothing to see here' }, // no-op: skipped
        { segmentId: c!, text: 'the dr said 50% off', speaker: 'Dana' },
      ],
      compact: false,
    });
    expect(res.updated).toBe(2);
    if (!('segments' in res)) throw new Error('expected the full response');
    expect(res.segments.map((s) => s.edited)).toEqual([true, false, true]);
    expect(res.segments[2]).toMatchObject({ speaker: 'Dana', text: 'the dr said 50% off' });
    // Batch edits keep the recorded timings of unchanged words too.
    const [first] = await call(agent, 'transcript.get', { sessionId: session.id, toSec: 9 });
    expect(first!.words.slice(0, 4)).toEqual([
      { w: 'Ask', s: 0, e: 1 },
      { w: 'Dr', s: 1, e: 2 },
      { w: 'Smith', s: 2, e: 3 },
      { w: 'about', s: 3, e: 4 },
    ]);

    const changes = await call(owner, 'changes.list', { sessionId: session.id, via: 'mcp' });
    expect(changes).toHaveLength(2);
    await call(owner, 'changes.revert', { changeId: changes[0]!.id });
    const after = await call(owner, 'transcript.get', { sessionId: session.id });
    expect(after.map((s) => s.text)).toEqual([
      'Ask Dr Smith about x squared',
      'nothing to see here',
      'the doctor said 50% off',
    ]);
  });

  it('finds several patterns at once with matched text and context lines', async () => {
    const { owner, session } = await studio();
    const [a, b, c, d, e] = await seedTranscript(session.id, [
      "I'm sure the Doctor will see m",
      'call it at x',
      '-one and then doctor again',
      'filler',
      'more filler',
    ]);

    const many = await findLines(owner, {
      sessionId: session.id,
      patterns: ['\\mdoctor\\M', '\\mm\\M', '^-one'],
      regex: true,
    });
    expect(many.map((l) => [l.id, l.matches, l.patternIndexes])).toEqual([
      [a, ['Doctor', 'm'], [0, 1]],
      [c, ['doctor', '-one'], [0, 2]],
    ]);
    // Empty-string hits (`z*` matches everywhere) are neither matches nor a reason to return a line.
    const empties = await findLines(owner, {
      sessionId: session.id,
      patterns: ['z*', 'x+'],
      regex: true,
    });
    expect(empties.map((l) => [l.id, l.matches, l.patternIndexes])).toEqual([[b, ['x'], [1]]]);
    // Plain text: literal metacharacters, each distinct matched substring once.
    const [plain] = await findLines(owner, { sessionId: session.id, pattern: 'X' });
    expect(plain).toMatchObject({ id: b, matches: ['x'], patternIndexes: [0] });

    const withContext = await findLines(owner, {
      sessionId: session.id,
      pattern: '-one',
      context: 1,
    });
    expect(withContext.map((l) => [l.id, l.context ?? false])).toEqual([
      [b, true],
      [c, false],
      [d, true],
    ]);
    expect(withContext[0]).not.toHaveProperty('matches');
    expect(withContext.some((l) => l.id === e)).toBe(false);

    await failsWith(
      call(owner, 'transcript.find', { sessionId: session.id, pattern: 'a', patterns: ['b'] }),
      'bad_request',
    );
    await failsWith(call(owner, 'transcript.find', { sessionId: session.id }), 'bad_request');
  });

  it('rejects readers, outsiders, and a batch naming a segment from another session', async () => {
    const { owner, team, show, session } = await studio();
    const [a] = await seedTranscript(session.id, ['hello there']);
    const other = await call(owner, 'sessions.create', { showId: show.id });
    const [foreign] = await seedTranscript(other.id, ['elsewhere']);

    const reader = await makeUser('reader@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: reader.user.email });
    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: reader.user.id,
      showId: show.id,
      access: 'read',
    });
    expect(await findLines(reader, { sessionId: session.id, pattern: 'hello' })).toHaveLength(1);
    await failsWith(
      call(reader, 'transcript.updateSegments', {
        sessionId: session.id,
        updates: [{ segmentId: a!, text: 'hi' }],
      }),
      'forbidden',
    );

    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'transcript.find', { sessionId: session.id, pattern: 'hello' }),
      'not_found',
    );

    await failsWith(
      call(owner, 'transcript.updateSegments', {
        sessionId: session.id,
        updates: [
          { segmentId: a!, text: 'hi' },
          { segmentId: foreign!, text: 'nope' },
        ],
      }),
      'not_found',
    );
    // The foreign id is rejected up front; the valid entry in the same batch is not applied.
    const [unchanged] = await call(owner, 'transcript.get', { sessionId: session.id });
    expect(unchanged?.text).toBe('hello there');
  });
});

const words = [
  { w: 'Ask', s: 10, e: 10.4 },
  { w: 'the', s: 10.4, e: 10.6 },
  { w: 'doctor', s: 10.7, e: 11.2 },
  { w: 'about', s: 11.3, e: 11.6 },
  { w: 'it.', s: 11.6, e: 12 },
];

describe('transcript.updateSegment', () => {
  it('keeps real word timings for unchanged words, and undo restores the original', async () => {
    const { owner, session } = await studio();
    const segmentId = newId('seg');
    await db.insert(schema.transcriptSegments).values({
      id: segmentId,
      sessionId: session.id,
      startSec: 10,
      endSec: 12,
      speaker: 'Speaker 1',
      text: 'Ask the doctor about it.',
      words,
    });

    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'transcript.updateSegment', { segmentId, text: 'Ask the dr about it.' }),
      'not_found',
    );

    const edited = await call(owner, 'transcript.updateSegment', {
      segmentId,
      text: 'Ask the dr about it.',
    });
    expect(edited.words).toEqual([words[0], words[1], { ...words[2], w: 'dr' }, ...words.slice(3)]);

    const change = (await call(owner, 'changes.list', { sessionId: session.id })).find(
      (c) => c.entity === 'transcript_segment' && c.entityId === segmentId,
    );
    await call(owner, 'changes.revert', { changeId: change!.id });
    const [restored] = await call(owner, 'transcript.get', { sessionId: session.id });
    expect(restored).toMatchObject({ text: 'Ask the doctor about it.', words });
  });
});
