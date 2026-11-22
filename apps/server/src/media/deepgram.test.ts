import { keyTermsChars, MAX_KEY_TERMS_TOTAL_CHARS, opInputs } from '@autologger/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DeepgramResponse,
  deepgramUrl,
  mapDeepgram,
  PermanentError,
  transcribeAudio,
} from './deepgram.ts';
import { isYoutubeUrl } from './youtube.ts';

const fixture: DeepgramResponse = {
  metadata: { duration: 12.5 },
  results: {
    channels: [{ alternatives: [{ transcript: 'hello there welcome back yes thanks' }] }],
    utterances: [
      {
        start: 6.1,
        end: 8.4,
        transcript: 'Yes, thanks.',
        speaker: 1,
        words: [
          { word: 'yes', punctuated_word: 'Yes,', start: 6.1, end: 6.5, speaker: 1 },
          { word: 'thanks', punctuated_word: 'thanks.', start: 6.6, end: 8.4, speaker: 1 },
        ],
      },
      {
        start: 0.24,
        end: 2.8,
        transcript: 'Hello there, welcome back.',
        speaker: 0,
        words: [
          { word: 'hello', punctuated_word: 'Hello', start: 0.24, end: 0.6, speaker: 0 },
          { word: 'there', punctuated_word: 'there,', start: 0.6, end: 1.0, speaker: 0 },
          { word: 'welcome', punctuated_word: 'welcome', start: 1.2, end: 1.9, speaker: 0 },
          { word: 'back', punctuated_word: 'back.', start: 1.9, end: 2.8, speaker: 0 },
        ],
      },
      { start: 9, end: 9.5, transcript: '  ', speaker: 0, words: [] },
    ],
  },
};

describe('mapDeepgram', () => {
  it('maps utterances to transcript rows offset by the segment start, in time order', () => {
    const rows = mapDeepgram(fixture, 100);
    expect(rows).toEqual([
      {
        startSec: 100.24,
        endSec: 102.8,
        speaker: 'Speaker 1',
        text: 'Hello there, welcome back.',
        words: [
          { w: 'Hello', s: 100.24, e: 100.6, sp: 0 },
          { w: 'there,', s: 100.6, e: 101, sp: 0 },
          { w: 'welcome', s: 101.2, e: 101.9, sp: 0 },
          { w: 'back.', s: 101.9, e: 102.8, sp: 0 },
        ],
      },
      {
        startSec: 106.1,
        endSec: 108.4,
        speaker: 'Speaker 2',
        text: 'Yes, thanks.',
        words: [
          { w: 'Yes,', s: 106.1, e: 106.5, sp: 1 },
          { w: 'thanks.', s: 106.6, e: 108.4, sp: 1 },
        ],
      },
    ]);
  });

  it('splits an utterance where the word-level speaker changes, ignoring short blips', () => {
    const word = (w: string, start: number, end: number, speaker: number) => ({
      word: w.toLowerCase(),
      punctuated_word: w,
      start,
      end,
      speaker,
    });
    const rows = mapDeepgram(
      {
        results: {
          utterances: [
            {
              start: 1,
              end: 6,
              transcript: 'How did it go? Yeah. Great, thanks. Mm. Really well.',
              speaker: 0,
              words: [
                word('How', 1, 1.2, 0),
                word('did', 1.2, 1.4, 0),
                word('it', 1.4, 1.5, 0),
                word('go?', 1.5, 1.9, 0),
                // A long-enough answer from speaker 1 …
                word('Yeah.', 2.2, 2.6, 1),
                word('Great,', 2.7, 3.1, 1),
                word('thanks.', 3.1, 3.6, 1),
                // … with a 0.2 s one-word blip labelled speaker 0 inside it.
                word('Mm.', 3.7, 3.9, 0),
                word('Really', 4, 4.5, 1),
                word('well.', 4.5, 5.8, 1),
              ],
            },
          ],
        },
      },
      10,
    );
    expect(
      rows.map(({ startSec, endSec, speaker, text }) => ({ startSec, endSec, speaker, text })),
    ).toEqual([
      { startSec: 11, endSec: 11.9, speaker: 'Speaker 1', text: 'How did it go?' },
      {
        startSec: 12.2,
        endSec: 16,
        speaker: 'Speaker 2',
        text: 'Yeah. Great, thanks. Mm. Really well.',
      },
    ]);
    expect(rows[1]!.words[3]).toEqual({ w: 'Mm.', s: 13.7, e: 13.9, sp: 0 });
  });

  it('falls back to the channel transcript when there are no utterances', () => {
    const rows = mapDeepgram(
      {
        metadata: { duration: 3 },
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: 'One two.',
                  words: [
                    { word: 'one', punctuated_word: 'One', start: 0.5, end: 0.9 },
                    { word: 'two', start: 1, end: 1.4 },
                  ],
                },
              ],
            },
          ],
        },
      },
      10,
    );
    expect(rows).toEqual([
      {
        startSec: 10.5,
        endSec: 11.4,
        speaker: '',
        text: 'One two.',
        words: [
          { w: 'One', s: 10.5, e: 10.9 },
          { w: 'two', s: 11, e: 11.4 },
        ],
      },
    ]);
  });

  it('returns nothing for silence', () => {
    expect(
      mapDeepgram(
        {
          metadata: { duration: 2 },
          results: { channels: [{ alternatives: [{ transcript: '' }] }], utterances: [] },
        },
        0,
      ),
    ).toEqual([]);
  });
});

describe('isYoutubeUrl', () => {
  it('accepts youtube.com and youtu.be only', () => {
    expect(isYoutubeUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(isYoutubeUrl('https://youtu.be/abc')).toBe(true);
    expect(isYoutubeUrl('https://youtube.com.evil.example/watch')).toBe(false);
    expect(isYoutubeUrl('ftp://youtube.com/x')).toBe(false);
  });
});

describe('deepgramUrl', () => {
  const params = (url: string) => new URL(url).searchParams;

  it('keeps the previous defaults: nova-3 with smart formatting, no key terms', () => {
    const q = params(deepgramUrl());
    expect(q.get('model')).toBe('nova-3');
    expect(q.get('smart_format')).toBe('true');
    expect(q.get('punctuate')).toBe('true');
    expect(q.get('diarize')).toBe('true');
    expect(q.get('utterances')).toBe('true');
    expect(q.has('keyterm')).toBe(false);
  });

  it('turns smart formatting off and repeats keyterm once per URL-encoded term', () => {
    const url = deepgramUrl({
      smartFormat: false,
      keyTerms: [' dx ', 'L’Hôpital', 'chain rule', 'dx', '', 'a&b=c'],
    });
    expect(params(url).get('smart_format')).toBe('false');
    expect(params(url).get('punctuate')).toBe('true');
    expect(params(url).getAll('keyterm')).toEqual(['dx', 'L’Hôpital', 'chain rule', 'a&b=c']);
    expect(url).toContain('keyterm=chain+rule');
    expect(url).toContain('keyterm=a%26b%3Dc');
    expect(url).not.toContain('Hôpital');
  });

  it('caps the number and length of key terms', () => {
    const many = Array.from({ length: 80 }, (_, i) => `term${i}`);
    expect(
      params(deepgramUrl({ smartFormat: true, keyTerms: many })).getAll('keyterm'),
    ).toHaveLength(50);
    const [long] = params(deepgramUrl({ smartFormat: true, keyTerms: ['x'.repeat(200)] })).getAll(
      'keyterm',
    );
    expect(long).toHaveLength(50);
  });

  it('drops key terms past the total character budget', () => {
    // 30 distinct 40-character terms = 1200 characters; only 25 fit in 1000.
    const terms = Array.from({ length: 30 }, (_, i) => `${i}`.padStart(40, 'k'));
    const sent = params(deepgramUrl({ smartFormat: true, keyTerms: terms })).getAll('keyterm');
    expect(sent).toEqual(terms.slice(0, 25));
    expect(keyTermsChars(sent)).toBeLessThanOrEqual(MAX_KEY_TERMS_TOTAL_CHARS);
  });
});

describe('shows.update key term validation', () => {
  const input = opInputs['shows.update'];
  it('rejects a list over the total character budget with a clear message', () => {
    const over = input.safeParse({
      showId: 'show_1',
      keyTerms: Array.from({ length: 21 }, (_, i) => `${i}`.padStart(50, 'k')),
    });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toMatch(/at most 1000 characters/);
    expect(
      input.safeParse({ showId: 'show_1', keyTerms: Array(20).fill('k'.repeat(50)) }).success,
    ).toBe(true);
  });
});

describe('transcribeAudio errors', () => {
  afterEach(() => vi.unstubAllGlobals());
  const call = () => transcribeAudio('key', new Blob(['x']).stream(), 'audio/mpeg', 1);
  const answer = (status: number, body: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status })),
    );

  it('makes a 4xx permanent, with Deepgram’s (truncated) reason', async () => {
    answer(400, `{"err_msg":"Too many keyterm tokens"}${' '.repeat(10)}${'x'.repeat(500)}`);
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toMatch(/rejected the request \(400\).*Too many keyterm tokens/);
    expect((err as Error).message.length).toBeLessThan(500);
  });

  it('keeps rate limiting and server errors retryable', async () => {
    for (const status of [429, 503]) {
      answer(status, 'busy');
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PermanentError);
    }
  });
});
