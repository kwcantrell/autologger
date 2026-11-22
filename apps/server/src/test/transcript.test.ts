import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

const words = [
  { w: 'Ask', s: 10, e: 10.4 },
  { w: 'the', s: 10.4, e: 10.6 },
  { w: 'doctor', s: 10.7, e: 11.2 },
  { w: 'about', s: 11.3, e: 11.6 },
  { w: 'it.', s: 11.6, e: 12 },
];

describe('transcript.updateSegment', () => {
  it('keeps real word timings for unchanged words, and undo restores the original', async () => {
    const { owner, show, session } = await studio();
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

    const [change] = await call(owner, 'changes.list', { showId: show.id });
    await call(owner, 'changes.revert', { changeId: change!.id });
    const [restored] = await call(owner, 'transcript.get', { sessionId: session.id });
    expect(restored).toMatchObject({ text: 'Ask the doctor about it.', words });
  });
});
