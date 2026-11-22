// Two-speaker transcription through transcribeAudio + mapDeepgram (#109).
//
// The live call is opt-in and costs real Deepgram credit (a ~9 s clip, well under a cent). It runs
// only when BOTH are set:
//   DEEPGRAM_LIVE_TEST=1          explicit opt-in (set by `npm run test:deepgram`)
//   DEEPGRAM_TEST_API_KEY=<key>   a Deepgram key (vitest blanks DEEPGRAM_API_KEY for every test)
// e.g. `DEEPGRAM_TEST_API_KEY=… npm run test:deepgram -w @autologger/server`.
//
// Without them the live test is skipped and the same checks run against a sample response in
// Deepgram's shape (fixtures/two-speakers.deepgram.json), so the assertions themselves stay tested.
// The audio is fixtures/two-speakers.ogg: two synthetic voices, see fixtures/make-two-speakers.sh.

import { readFileSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DeepgramResponse, mapDeepgram, transcribeAudio } from './deepgram.ts';

const audioPath = new URL('./fixtures/two-speakers.ogg', import.meta.url);
const samplePath = new URL('./fixtures/two-speakers.deepgram.json', import.meta.url);

const optedIn = process.env.DEEPGRAM_LIVE_TEST === '1';
const apiKey = process.env.DEEPGRAM_TEST_API_KEY ?? '';

/** Transcribe the fixture clip through our request code, as the worker does. */
const transcribeFixture = (key: string) => {
  const bytes = readFileSync(audioPath);
  return transcribeAudio(key, new Blob([bytes]).stream(), 'audio/ogg', statSync(audioPath).size, {
    smartFormat: true,
    keyTerms: [],
  });
};

const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * The clip is speaker A asking "… How was your trip to Denver?" and speaker B answering "It was
 * great, thanks. The mountains were beautiful." Checks what the worker relies on.
 */
function expectTwoSpeakerTranscript(resp: DeepgramResponse, offsetSec: number) {
  // The v2 diarizer ran (diarize_model=latest, #173), not the deprecated v1 that diarize=true gets.
  expect(resp.metadata?.diarize_info?.arch, 'metadata.diarize_info.arch').toBeDefined();
  expect(resp.metadata?.diarize_info?.arch).not.toBe('v1');

  // Word-level speakers change exactly at the turn boundary ("Denver?" | "It").
  const words = resp.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  const turn = words.findIndex(
    (w, i) => bare(w.word) === 'denver' && bare(words[i + 1]?.word ?? '') === 'it',
  );
  expect(turn, `turn boundary in "${words.map((w) => w.word).join(' ')}"`).toBeGreaterThan(0);
  const [a, b] = [words[0]!.speaker, words[turn + 1]!.speaker];
  expect(typeof a).toBe('number');
  expect(b).not.toBe(a);
  expect(words.slice(0, turn + 1).map((w) => w.speaker)).toEqual(Array(turn + 1).fill(a));
  expect(words.slice(turn + 1).map((w) => w.speaker)).toEqual(
    Array(words.length - turn - 1).fill(b),
  );

  // Our rows: at least two, split at the speaker change, with session-time word timings.
  const rows = mapDeepgram(resp, offsetSec);
  expect(rows.length).toBeGreaterThanOrEqual(2);
  expect(new Set(rows.map((r) => r.speaker)).size).toBeGreaterThanOrEqual(2);
  const ask = rows.findIndex((r) => bare(r.words.at(-1)?.w ?? '') === 'denver');
  expect(ask, 'a row ending with "Denver?"').toBeGreaterThanOrEqual(0);
  const answer = rows[ask + 1];
  expect(bare(answer?.words[0]?.w ?? '')).toBe('it');
  expect(answer!.speaker).not.toBe(rows[ask]!.speaker);
  expect(rows.flatMap((r) => r.words.map((w) => bare(w.w)))).toContain('mountains');
  for (const r of rows) {
    expect(r.text.trim()).not.toBe('');
    expect(r.words.length).toBeGreaterThan(0);
    for (const [i, w] of r.words.entries()) {
      expect(w.s).toBeLessThanOrEqual(w.e);
      expect(w.s).toBeGreaterThanOrEqual(r.startSec);
      expect(w.e).toBeLessThanOrEqual(r.endSec);
      if (i > 0) expect(w.s).toBeGreaterThanOrEqual(r.words[i - 1]!.s);
    }
  }
  // The clip is ~9.4 s; timings are offset into session time.
  expect(rows[0]!.startSec).toBeGreaterThanOrEqual(offsetSec);
  expect(rows.at(-1)!.endSec).toBeLessThanOrEqual(offsetSec + 10);
}

describe('two-speaker transcription (sample response)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the clip with diarize_model=latest and maps the turns to separate rows', async () => {
    const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as DeepgramResponse;
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json(sample));
    vi.stubGlobal('fetch', fetchMock);

    const resp = await transcribeFixture('test-key');

    const [url, init] = fetchMock.mock.calls[0]!;
    const q = new URL(url).searchParams;
    expect(q.get('diarize_model')).toBe('latest');
    expect(q.has('diarize')).toBe(false);
    expect(q.get('utterances')).toBe('true');
    expect(init.headers).toMatchObject({
      Authorization: 'Token test-key',
      'Content-Type': 'audio/ogg',
      'Content-Length': String(statSync(audioPath).size),
    });
    expectTwoSpeakerTranscript(resp, 30);
  });

  it('fails the checks when the v1 diarizer ran or the speakers never change', () => {
    const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as DeepgramResponse;
    const v1 = structuredClone(sample);
    v1.metadata!.diarize_info!.arch = 'v1';
    expect(() => expectTwoSpeakerTranscript(v1, 0)).toThrow();
    const oneSpeaker = structuredClone(sample);
    for (const w of oneSpeaker.results!.channels![0]!.alternatives![0]!.words!) w.speaker = 0;
    for (const w of oneSpeaker.results!.utterances![0]!.words!) w.speaker = 0;
    expect(() => expectTwoSpeakerTranscript(oneSpeaker, 0)).toThrow();
  });
});

describe.runIf(optedIn)('two-speaker transcription (live Deepgram)', () => {
  it('transcribes the clip with two speakers split at the turn', { timeout: 60_000 }, async () => {
    if (!apiKey)
      throw new Error('DEEPGRAM_LIVE_TEST=1 needs DEEPGRAM_TEST_API_KEY set to a Deepgram key');
    const resp = await transcribeFixture(apiKey);
    // Shown in the run output so a failure (or a new diarizer) is easy to read.
    console.info('diarize_info', resp.metadata?.diarize_info);
    console.info(
      mapDeepgram(resp, 0)
        .map((r) => `[${r.startSec}–${r.endSec}] ${r.speaker}: ${r.text}`)
        .join('\n'),
    );
    expectTwoSpeakerTranscript(resp, 0);
  });
});
