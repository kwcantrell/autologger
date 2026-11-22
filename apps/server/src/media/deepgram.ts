// Deepgram pre-recorded transcription. The mapping from Deepgram's response to transcript rows is
// pure (no db) so it can be unit-tested with a fixture.

import { MAX_KEY_TERM_LENGTH, MAX_KEY_TERMS, type TranscriptWord } from '@autologger/contract';

const DEEPGRAM_LISTEN = 'https://api.deepgram.com/v1/listen';

/** Per-show transcription settings (columns on `shows`). */
export interface TranscriptionOptions {
  smartFormat: boolean;
  keyTerms: string[];
}

export const DEFAULT_TRANSCRIPTION_OPTIONS: TranscriptionOptions = {
  smartFormat: true,
  keyTerms: [],
};

/**
 * Build the Deepgram pre-recorded URL for a show's settings. Punctuation stays on even without
 * smart formatting. Key terms use nova-3 keyterm prompting: one repeated `keyterm` parameter per
 * term (URL-encoded, so multi-word terms stay one term), trimmed, de-duplicated and capped.
 */
export function deepgramUrl(opts: TranscriptionOptions = DEFAULT_TRANSCRIPTION_OPTIONS): string {
  const q = new URLSearchParams({
    model: 'nova-3',
    smart_format: String(opts.smartFormat),
    diarize: 'true',
    utterances: 'true',
    punctuate: 'true',
  });
  const terms = new Set<string>();
  for (const raw of opts.keyTerms) {
    const t = raw.trim().slice(0, MAX_KEY_TERM_LENGTH);
    if (t) terms.add(t);
    if (terms.size >= MAX_KEY_TERMS) break;
  }
  for (const t of terms) q.append('keyterm', t);
  return `${DEEPGRAM_LISTEN}?${q.toString()}`;
}

export interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
}

export interface DeepgramUtterance {
  start: number;
  end: number;
  transcript: string;
  speaker?: number;
  words?: DeepgramWord[];
}

export interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    utterances?: DeepgramUtterance[];
    channels?: { alternatives?: { transcript?: string; words?: DeepgramWord[] }[] }[];
  };
}

export interface MappedSegment {
  startSec: number;
  endSec: number;
  speaker: string;
  text: string;
  words: TranscriptWord[];
}

/** Errors that retrying won't fix (bad key, unsupported audio, …). */
export class PermanentError extends Error {}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

const speakerLabel = (s: number | undefined) => (typeof s === 'number' ? `Speaker ${s + 1}` : '');

/** Map Deepgram utterances to transcript rows, offset to session time by `offsetSec`. */
export function mapDeepgram(resp: DeepgramResponse, offsetSec: number): MappedSegment[] {
  const mapWords = (ws: DeepgramWord[] | undefined): TranscriptWord[] =>
    (ws ?? []).map((w) => ({
      w: w.punctuated_word ?? w.word,
      s: r3(w.start + offsetSec),
      e: r3(w.end + offsetSec),
    }));

  const utterances = resp.results?.utterances ?? [];
  if (utterances.length > 0) {
    return utterances
      .filter((u) => u.transcript.trim().length > 0)
      .sort((a, b) => a.start - b.start)
      .map((u) => ({
        startSec: r3(u.start + offsetSec),
        endSec: r3(u.end + offsetSec),
        speaker: speakerLabel(u.speaker),
        text: u.transcript.trim(),
        words: mapWords(u.words),
      }));
  }
  // No utterances (e.g. silence or an older response shape): fall back to one segment per channel.
  const alt = resp.results?.channels?.[0]?.alternatives?.[0];
  const text = alt?.transcript?.trim();
  if (!alt || !text) return [];
  const words = alt.words ?? [];
  return [
    {
      startSec: r3((words[0]?.start ?? 0) + offsetSec),
      endSec: r3((words.at(-1)?.end ?? resp.metadata?.duration ?? 0) + offsetSec),
      speaker: speakerLabel(words[0]?.speaker),
      text,
      words: mapWords(words),
    },
  ];
}

/** POST the audio to Deepgram and return the parsed response. */
export async function transcribeAudio(
  apiKey: string,
  body: ReadableStream<Uint8Array>,
  mimeType: string,
  size: number | null,
  opts: TranscriptionOptions = DEFAULT_TRANSCRIPTION_OPTIONS,
): Promise<DeepgramResponse> {
  const headers: Record<string, string> = {
    Authorization: `Token ${apiKey}`,
    'Content-Type': mimeType.split(';')[0]!.trim() || 'application/octet-stream',
  };
  if (size !== null) headers['Content-Length'] = String(size);
  const res = await fetch(deepgramUrl(opts), {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
    signal: AbortSignal.timeout(60 * 60 * 1000),
  } as RequestInit & { duplex: 'half' });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const msg = `Deepgram answered ${res.status}${detail ? `: ${detail}` : ''}`;
    // 4xx (except rate limiting / timeouts) won't succeed on retry.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
      throw new PermanentError(msg);
    throw new Error(msg);
  }
  return (await res.json()) as DeepgramResponse;
}
