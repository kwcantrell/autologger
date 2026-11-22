import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

type Seg = { startSec: number; endSec: number; speaker: string; text: string };

async function seed(sessionId: string, segs: Seg[]) {
  const rows = segs.map((s) => ({ id: newId('seg'), sessionId, ...s, words: [] }));
  await db.insert(schema.transcriptSegments).values(rows);
  return rows.map((r) => r.id);
}

/**
 * ~60 minutes of diarized interview: runs of same-speaker turns, many of them 1-3-word
 * fragments, as Deepgram produces for cross-talk. Deterministic (fixed LCG seed).
 */
function syntheticHour(): Seg[] {
  let x = 42;
  const rand = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  const words =
    'so the thing is we went to Columbia and honestly it was like the best show ever right'.split(
      ' ',
    );
  const speakers = ['Speaker 0', 'Speaker 1', 'Tom'];
  const segs: Seg[] = [];
  let t = 0;
  let speaker = 0;
  while (t < 3600) {
    if (rand() < 0.35) speaker = (speaker + 1 + Math.floor(rand() * 2)) % speakers.length;
    const n = rand() < 0.6 ? 1 + Math.floor(rand() * 3) : 4 + Math.floor(rand() * 14);
    const text = Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]).join(
      ' ',
    );
    const dur = Math.round((0.4 * n + rand()) * 10) / 10;
    segs.push({
      startSec: Math.round(t * 10) / 10,
      endSec: Math.round((t + dur) * 10) / 10,
      speaker: speakers[speaker]!,
      text,
    });
    t += dur + 0.2;
  }
  return segs;
}

describe('transcript reading', () => {
  it('pages by start time, adds ids and paging numbers, keeps the default format', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    const [a, b, c] = await seed(session.id, [
      { startSec: 0, endSec: 9, speaker: 'Dana', text: 'hello' },
      { startSec: 8.5, endSec: 12, speaker: '', text: 'straddles the boundary' },
      { startSec: 10, endSec: 20.25, speaker: 'Dana', text: 'second page' },
    ]);

    const all = await call(agent, 'transcript.text', { sessionId: session.id });
    expect(all).toEqual({
      text: '[00:00:00 @0.0s] Dana: hello\n[00:00:08 @8.5s] Speaker: straddles the boundary\n[00:00:10 @10.0s] Dana: second page',
      segments: 3,
      chars: all.text.length,
      totalSegments: 3,
      durationSec: 20.3,
    });

    // A segment belongs to the page it starts in: [0, 10) and [10, ∞) do not overlap.
    const p1 = await call(agent, 'transcript.text', { sessionId: session.id, toSec: 10 });
    const p2 = await call(agent, 'transcript.text', { sessionId: session.id, fromSec: 10 });
    expect([p1.segments, p2.segments]).toEqual([2, 1]);
    expect(p2).toMatchObject({ text: '[00:00:10 @10.0s] Dana: second page', totalSegments: 3 });
    const p3 = await call(agent, 'transcript.text', {
      sessionId: session.id,
      fromSec: 5,
      toSec: 9,
    });
    expect(p3.text).toBe('[00:00:08 @8.5s] Speaker: straddles the boundary');

    const withIds = await call(agent, 'transcript.text', { sessionId: session.id, ids: true });
    expect(withIds.text.split('\n').map((l) => l.split(' ')[0])).toEqual([a, b, c]);

    const compact = await call(agent, 'transcript.text', {
      sessionId: session.id,
      format: 'compact',
      ids: true,
    });
    expect(compact.text).toBe(
      `@0.0 Dana: {${a}} hello\n@8.5 Speaker: {${b}} straddles the boundary\n@10.0 Dana: {${c}} second page`,
    );

    const outsider = await makeUser('outsider@example.com');
    await failsWith(call(outsider, 'transcript.text', { sessionId: session.id }), 'not_found');
  });

  it('compact text merges same-speaker runs and is at least 30% smaller on an hour', async () => {
    const { owner, session } = await studio();
    const segs = syntheticHour();
    await seed(session.id, segs);

    const lines = await call(owner, 'transcript.text', { sessionId: session.id });
    const compact = await call(owner, 'transcript.text', {
      sessionId: session.id,
      format: 'compact',
    });
    expect(compact.segments).toBe(segs.length);
    expect(compact.durationSec).toBeGreaterThanOrEqual(3600);
    const saved = 1 - compact.chars / lines.chars;
    console.info(
      `transcript.text on ${segs.length} segments: lines ${lines.chars} chars, compact ${compact.chars} chars (${Math.round(saved * 100)}% smaller)`,
    );
    expect(saved).toBeGreaterThanOrEqual(0.3);
    // Every word survives, and no paragraph goes a minute without a stamp.
    const strip = (s: string) => s.replace(/\[?@\d+\.\d\]?|(Speaker \d|Tom):|\[[^\]]*\]/g, '');
    expect(strip(compact.text).split(/\s+/).filter(Boolean)).toEqual(
      strip(lines.text).split(/\s+/).filter(Boolean),
    );
    for (const para of compact.text.split('\n')) {
      const stamps = [...para.matchAll(/@(\d+\.\d)/g)].map((m) => Number(m[1]));
      expect(stamps).toEqual([...stamps].sort((p, q) => p - q));
    }
  });

  it('transcript.find returns total, per-pattern counts and ids only', async () => {
    const { owner, session } = await studio();
    const [a, b, c] = await seed(session.id, [
      { startSec: 0, endSec: 1, speaker: 'Tom', text: 'Columbia again' },
      { startSec: 2, endSec: 3, speaker: 'Dana', text: 'columbia, yes, and Ohio' },
      { startSec: 4, endSec: 5, speaker: 'Tom', text: 'Ohio' },
    ]);
    const sessionId = session.id;

    const limited = await call(owner, 'transcript.find', {
      sessionId,
      pattern: 'columbia',
      limit: 1,
    });
    expect(limited.total).toBe(2);
    expect('lines' in limited && limited.lines.map((l) => l.id)).toEqual([a]);

    expect(
      await call(owner, 'transcript.find', {
        sessionId,
        patterns: ['columbia', 'ohio', 'nope'],
        countOnly: true,
      }),
    ).toEqual({ total: 3, counts: [2, 2, 0] });

    expect(
      await call(owner, 'transcript.find', {
        sessionId,
        pattern: '.',
        regex: true,
        idsOnly: true,
        toSec: 3,
      }),
    ).toEqual({
      total: 2,
      lines: [
        { id: a, startSec: 0, speaker: 'Tom' },
        { id: b, startSec: 2, speaker: 'Dana' },
      ],
    });
    const idsLimited = await call(owner, 'transcript.find', {
      sessionId,
      pattern: 'o',
      idsOnly: true,
      limit: 2,
    });
    expect(idsLimited).toMatchObject({ total: 3, lines: [{ id: a }, { id: b }] });
    expect(c).toBeDefined();

    await failsWith(
      call(owner, 'transcript.find', { sessionId, pattern: 'x', countOnly: true, idsOnly: true }),
      'bad_request',
    );
  });

  it('transcript.find suspect: true lists turns that may hold two speakers', async () => {
    const { owner, session } = await studio();
    const sessionId = session.id;
    // A merged question and answer as diarization produced it (Tom Talks Ep16, 244 s).
    const merged =
      'and you were a surprise guest, right? Yeah. The way that the audience responded to you, they lost their shit. It was wild to me. They lost... They were like, Oh my God. It was';
    const [a, , c] = await seed(sessionId, [
      { startSec: 244, endSec: 254, speaker: 'Talib', text: merged },
      { startSec: 255, endSec: 260, speaker: 'Tom', text: 'Did you feel nervous on stage?' },
      { startSec: 261, endSec: 330, speaker: 'Talib', text: 'A long story without questions.' },
    ]);

    const res = await call(owner, 'transcript.find', { sessionId, suspect: true });
    expect(res).toMatchObject({
      total: 2,
      lines: [
        { id: a, reasons: ['question'], matches: ['and you were a surprise guest, right?'] },
        { id: c, reasons: ['long'], matches: [] },
      ],
    });
    expect(
      await call(owner, 'transcript.find', { sessionId, suspect: true, countOnly: true }),
    ).toEqual({ total: 2, counts: [1, 1] });
    await failsWith(
      call(owner, 'transcript.find', { sessionId, suspect: true, pattern: 'x' }),
      'bad_request',
    );
    await failsWith(
      call(await makeUser('stranger@x.test'), 'transcript.find', { sessionId, suspect: true }),
      'not_found',
    );
  });

  it('find and get page by start time like text', async () => {
    const { owner, session } = await studio();
    const sessionId = session.id;
    const [a, b, c] = await seed(sessionId, [
      { startSec: 0, endSec: 9, speaker: 'Tom', text: 'Columbia one' },
      { startSec: 8.5, endSec: 12, speaker: 'Tom', text: 'Columbia straddles' },
      { startSec: 10, endSec: 15, speaker: 'Tom', text: 'Columbia two' },
    ]);
    const ids = async (fromSec?: number, toSec?: number) => {
      const res = await call(owner, 'transcript.find', {
        sessionId,
        pattern: 'columbia',
        idsOnly: true,
        fromSec,
        toSec,
      });
      return 'lines' in res ? res.lines.map((l) => l.id) : [];
    };
    // The straddling segment (8.5-12) is on the [0, 10) page only; toSec is exclusive.
    expect(await ids(0, 10)).toEqual([a, b]);
    expect(await ids(10, 20)).toEqual([c]);
    expect(await ids(9, 10)).toEqual([]);
    const got = await call(owner, 'transcript.get', { sessionId, fromSec: 10 });
    expect(got.map((s) => s.id)).toEqual([c]);
  });
});
