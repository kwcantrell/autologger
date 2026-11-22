import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

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

    const plain = await call(agent, 'transcript.find', {
      sessionId: session.id,
      pattern: 'DOCTOR',
    });
    expect(plain.map((l) => l.id)).toEqual([a, c]);
    expect(plain[0]).not.toHaveProperty('words');
    expect(
      await call(agent, 'transcript.find', { sessionId: session.id, pattern: '50%' }),
    ).toHaveLength(1);
    expect(
      (
        await call(agent, 'transcript.find', {
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
    });
    expect(res.updated).toBe(2);
    expect(res.segments.map((s) => s.edited)).toEqual([true, false, true]);
    expect(res.segments[2]).toMatchObject({ speaker: 'Dana', text: 'the dr said 50% off' });

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
    expect(
      await call(reader, 'transcript.find', { sessionId: session.id, pattern: 'hello' }),
    ).toHaveLength(1);
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
