import { describe, expect, it } from 'vitest';
import { type DeepgramResponse, mapDeepgram } from './deepgram.ts';
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
          { w: 'Hello', s: 100.24, e: 100.6 },
          { w: 'there,', s: 100.6, e: 101 },
          { w: 'welcome', s: 101.2, e: 101.9 },
          { w: 'back.', s: 101.9, e: 102.8 },
        ],
      },
      {
        startSec: 106.1,
        endSec: 108.4,
        speaker: 'Speaker 2',
        text: 'Yes, thanks.',
        words: [
          { w: 'Yes,', s: 106.1, e: 106.5 },
          { w: 'thanks.', s: 106.6, e: 108.4 },
        ],
      },
    ]);
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
