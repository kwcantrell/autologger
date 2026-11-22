import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { applyShowRules, runRules } from '../media/rules.ts';
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
    // Matches empty text: would insert the replacement everywhere.
    await failsWith(
      call(owner, 'shows.update', {
        showId: show.id,
        transcriptRules: [{ find: 'x*', replace: '-', regex: true }],
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

// A backreference pattern PostgreSQL cannot finish on this text within the timeout.
const SLOW = { find: '(a*)(a*)(a*)\\1\\2\\3\\1b\\1', replace: 'x', regex: true };
const slowText = `${'a'.repeat(3000)}b`;

describe('rule matching in PostgreSQL', () => {
  it('applies rules in order with PostgreSQL regex semantics', async () => {
    const run = await db.transaction((tx) =>
      runRules(
        tx,
        ['Doctor x over dsdt, doctor.', 'sin x, sinh, résin, Sin(x)', 'a.b a+b c2x2'],
        [
          { find: 'doctor', replace: 'dr', wholeWord: true },
          { find: 'd(\\w)d(\\w)', replace: 'd\\1 d\\2', regex: true },
          { find: 'dr x', replace: 'dr(x)' }, // sees the output of the first rule
          { find: 'sin', replace: 'sine', wholeWord: true, caseSensitive: true },
          { find: 'a.b', replace: '\\1&' }, // literal: no regex, no backreference
          { find: '\\mc(\\d)x(\\d)\\M', replace: 'c\\1 x^\\2', regex: true },
        ],
        { budgetMs: 5000, onError: 'throw' },
      ),
    );
    expect(run.texts).toEqual([
      'Dr(x) over ds dt, dr.', // literal rules keep the leading capital
      'sine x, sinh, résin, Sin(x)',
      '\\1& a+b c2 x^2',
    ]);
    expect(run.counts).toEqual([2, 1, 1, 1, 1, 1]);
  });

  it('keeps the case of matches for literal case-insensitive rules (preserveCase)', async () => {
    const texts = [
      'The 5,711 and the 5,711. THE 5,711!',
      'Fubu, fubu and FUBU.',
      'Ask Doctor Smith, the DOCTOR.',
      'The x\uFDD0 marker', // holds a marker: plain replacement
    ];
    const run = await db.transaction((tx) =>
      runRules(
        tx,
        texts,
        [
          { find: 'the 5,711', replace: 'the 5711' },
          { find: 'fubu', replace: 'FUBU', wholeWord: true },
          { find: 'doctor', replace: 'dr', wholeWord: true, preserveCase: false },
          { find: 'ask (\\w+)', replace: 'ask \\1', regex: true }, // regex: as written
          { find: 'the x', replace: 'the y' },
        ],
        { budgetMs: 5000, onError: 'throw' },
      ),
    );
    expect(run.texts).toEqual([
      'The 5711 and the 5711. The 5711!', // ALL CAPS only for one-word replacements
      'FUBU, FUBU and FUBU.',
      'ask dr Smith, the dr.',
      'the y\uFDD0 marker',
    ]);
    expect(run.counts).toEqual([3, 3, 2, 1, 1]);

    // The transcribe job's path applies it too.
    const seg = { startSec: 0, endSec: 2, text: 'The x said hi.', words: [] };
    const job = await applyShowRules([seg], [{ find: 'the x', replace: 'the y' }]);
    expect(job.segments[0]!.text).toBe('The y said hi.');
  });

  it('skips a rule that times out (worker mode) and keeps applying the rest', async () => {
    const started = Date.now();
    const run = await db.transaction((tx) =>
      runRules(tx, [slowText, 'the doctor'], [SLOW, doctorRule], {
        budgetMs: 30_000,
        onError: 'skip',
      }),
    );
    expect(run.skipped).toEqual([{ index: 0, reason: 'timeout' }]);
    expect(run.texts).toEqual([slowText, 'the dr']);
    expect(Date.now() - started).toBeLessThan(4000);
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
          after: 'Ask Dr Smith',
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
    // A rule that would empty a segment leaves it alone.
    expect(
      await call(agent, 'transcript.replace', {
        sessionId: session.id,
        rules: [{ find: 'nothing here', replace: '' }],
        dryRun: true,
      }),
    ).toMatchObject({ changed: 0, rules: [{ count: 1 }] });
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
      'Ask Dr Smith',
      'nothing here',
      'the dr said doctors',
    ]);
    expect(after[0]!.edited).toBe(true);
    expect(after[0]!.words[1]).toEqual({ w: 'Dr', s: 1, e: 2 });

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
    // A pathological regex is cut off by the statement timeout: bad_request in about 2 s.
    await seedTranscript(session.id, [slowText]);
    const started = Date.now();
    await failsWith(
      call(owner, 'transcript.replace', { sessionId: session.id, rules: [SLOW] }),
      'bad_request',
    );
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
