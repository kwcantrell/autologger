import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { handlers } from '../worker/handlers.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

// The transcribe job without Deepgram or S3: a canned Deepgram response.
vi.mock('../env.ts', async (orig) => {
  const mod = await orig<typeof import('../env.ts')>();
  return { ...mod, transcriptionConfigured: true, env: { ...mod.env, deepgramApiKey: 'test' } };
});
vi.mock('../media/s3.ts', async (orig) => ({
  ...(await orig<typeof import('../media/s3.ts')>()),
  getObjectStream: async () => ({ body: null, size: 0 }),
}));
vi.mock('../media/deepgram.ts', async (orig) => ({
  ...(await orig<typeof import('../media/deepgram.ts')>()),
  transcribeAudio: async () => ({
    metadata: { duration: 4 },
    results: {
      utterances: [
        {
          start: 0,
          end: 2,
          speaker: 0,
          transcript: 'Ask the doctor about dsdt.',
          words: ['Ask', 'the', 'doctor', 'about', 'dsdt.'].map((w, i) => ({
            word: w,
            punctuated_word: w,
            start: i * 0.4,
            end: i * 0.4 + 0.3,
            speaker: 0,
          })),
        },
      ],
    },
  }),
}));

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

const doctorRule = { find: 'doctor', replace: 'dr', wholeWord: true };

describe('show transcript rules', () => {
  it('are saved with shows.update and applied by the transcribe job, keeping timings', async () => {
    const { owner, show, session } = await studio();
    expect(show.transcriptRules).toEqual([]);
    const rules = [doctorRule, { find: 'ds ?dt', replace: 'ds dt', regex: true }];
    expect(
      (await call(owner, 'shows.update', { showId: show.id, transcriptRules: rules }))
        .transcriptRules,
    ).toEqual(rules);
    await failsWith(
      call(owner, 'shows.update', {
        showId: show.id,
        transcriptRules: [{ find: '(', replace: '', regex: true }],
      }),
      'bad_request',
    );

    const audId = newId('aud');
    await db.insert(schema.audioSegments).values({
      id: audId,
      sessionId: session.id,
      ordinal: 1,
      startSec: 100,
      mimeType: 'audio/mpeg',
      origin: 'file',
      objectKey: 'k',
      status: 'ready',
    });
    const [job] = await db
      .insert(schema.jobs)
      .values({
        id: newId('job'),
        kind: 'transcribe',
        sessionId: session.id,
        payload: { segmentId: audId },
      })
      .returning();
    const note = await handlers.transcribe.run(job!);
    expect(note).toBe(
      'Transcribed 1 segment; rules made 2 replacements (doctor → dr ×1, ds ?dt → ds dt ×1)',
    );

    const [seg] = await db
      .select()
      .from(schema.transcriptSegments)
      .where(eq(schema.transcriptSegments.audioSegmentId, audId));
    expect(seg!.text).toBe('Ask the dr about ds dt.');
    expect(seg!.edited).toBe(false);
    expect(seg!.words.slice(0, 4)).toEqual([
      { w: 'Ask', s: 100, e: 100.3 },
      { w: 'the', s: 100.4, e: 100.7 },
      { w: 'dr', s: 100.8, e: 101.1 },
      { w: 'about', s: 101.2, e: 101.5 },
    ]);
    // "dsdt." became two words sharing the original word's time.
    expect(seg!.words.slice(4)).toEqual([
      { w: 'ds', s: 101.6, e: 101.75 },
      { w: 'dt.', s: 101.75, e: 101.9 },
    ]);
  });
});

describe('transcript.replace', () => {
  it('previews with dryRun, applies undoably, and can use the show’s saved rules', async () => {
    const { owner, show, session } = await studio();
    const agent = asAgent(owner, 'Claude Code');
    const [a, , c] = await seedTranscript(session.id, [
      'Ask Doctor Smith',
      'nothing here',
      'the doctor said doctors',
    ]);

    const preview = await call(agent, 'transcript.replace', {
      sessionId: session.id,
      rules: [doctorRule],
      dryRun: true,
    });
    expect(preview).toEqual({
      dryRun: true,
      changed: 2,
      rules: [{ find: 'doctor', replace: 'dr', count: 2 }],
      segments: [
        {
          id: a,
          startSec: 0,
          endSec: 9,
          speaker: 'Speaker 1',
          before: 'Ask Doctor Smith',
          after: 'Ask dr Smith',
        },
        {
          id: c,
          startSec: 20,
          endSec: 29,
          speaker: 'Speaker 1',
          before: 'the doctor said doctors',
          after: 'the dr said doctors',
        },
      ],
      truncated: false,
    });
    expect(await call(owner, 'changes.list', { sessionId: session.id })).toHaveLength(0);
    expect((await call(owner, 'transcript.get', { sessionId: session.id }))[0]!.text).toBe(
      'Ask Doctor Smith',
    );

    // fromSec/toSec narrow it; the real run writes one change per segment.
    const one = await call(agent, 'transcript.replace', {
      sessionId: session.id,
      rules: [doctorRule],
      fromSec: 15,
    });
    expect(one).toMatchObject({ dryRun: false, changed: 1 });

    // Without rules it uses the show's rules (and says so when there are none).
    await failsWith(call(agent, 'transcript.replace', { sessionId: session.id }), 'bad_request');
    await call(owner, 'shows.update', { showId: show.id, transcriptRules: [doctorRule] });
    expect(await call(agent, 'transcript.replace', { sessionId: session.id })).toMatchObject({
      changed: 1,
    });

    const after = await call(owner, 'transcript.get', { sessionId: session.id });
    expect(after.map((s) => s.text)).toEqual([
      'Ask dr Smith',
      'nothing here',
      'the dr said doctors',
    ]);
    expect(after[0]!.edited).toBe(true);
    expect(after[0]!.words[1]).toEqual({ w: 'dr', s: 1, e: 2 });

    const changes = await call(owner, 'changes.list', { sessionId: session.id, via: 'mcp' });
    expect(changes).toHaveLength(2);
    for (const ch of changes) await call(owner, 'changes.revert', { changeId: ch.id });
    expect(
      (await call(owner, 'transcript.get', { sessionId: session.id })).map((s) => s.text),
    ).toEqual(['Ask Doctor Smith', 'nothing here', 'the doctor said doctors']);
  });

  it('rejects readers, outsiders and invalid regexes', async () => {
    const { owner, team, show, session } = await studio();
    await seedTranscript(session.id, ['the doctor']);
    const reader = await makeUser('reader@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: reader.user.email });
    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: reader.user.id,
      showId: show.id,
      access: 'read',
    });
    const input = { sessionId: session.id, rules: [doctorRule], dryRun: true };
    await failsWith(call(reader, 'transcript.replace', input), 'forbidden');
    await failsWith(
      call(await makeUser('outsider@example.com'), 'transcript.replace', input),
      'not_found',
    );
    await failsWith(
      call(owner, 'transcript.replace', {
        sessionId: session.id,
        rules: [{ find: '[', replace: '', regex: true }],
      }),
      'bad_request',
    );
  });
});
