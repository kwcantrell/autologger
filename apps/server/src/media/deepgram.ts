// Deepgram pre-recorded transcription. The mapping from Deepgram's response to transcript rows is
// pure (no db) so it can be unit-tested with a fixture.

import {
  MAX_KEY_TERM_LENGTH,
  MAX_KEY_TERMS,
  MAX_KEY_TERMS_TOTAL_CHARS,
  type TranscriptWord,
} from '@autologger/contract';

const DEEPGRAM_LISTEN = 'https://api.deepgram.com/v1/listen';

/** Transcription settings: the show's, with the session's key terms ahead of the show's. */
export interface TranscriptionOptions {
  smartFormat: boolean;
  keyTerms: string[];
}

export const DEFAULT_TRANSCRIPTION_OPTIONS: TranscriptionOptions = {
  smartFormat: true,
  keyTerms: [],
};

/**
 * The key terms actually sent: trimmed, de-duplicated and capped by count, per-term length and
 * total length (Deepgram allows ~500 keyterm tokens per request). Earlier terms win, so session
 * terms listed first are kept over show terms.
 */
export function selectKeyTerms(keyTerms: string[]): string[] {
  const terms = new Set<string>();
  let budget = MAX_KEY_TERMS_TOTAL_CHARS;
  for (const raw of keyTerms) {
    const t = raw.trim().slice(0, MAX_KEY_TERM_LENGTH);
    if (!t || terms.has(t)) continue;
    // Over the token budget Deepgram rejects the whole request, so drop the rest instead.
    if (t.length > budget || terms.size >= MAX_KEY_TERMS) break;
    terms.add(t);
    budget -= t.length;
  }
  return [...terms];
}

/**
 * Build the Deepgram pre-recorded URL for the transcription settings. Punctuation stays on even
 * without smart formatting. Key terms use nova-3 keyterm prompting: one repeated `keyterm`
 * parameter per term (URL-encoded, so multi-word terms stay one term), see `selectKeyTerms`.
 */
export function deepgramUrl(opts: TranscriptionOptions = DEFAULT_TRANSCRIPTION_OPTIONS): string {
  const q = new URLSearchParams({
    model: 'nova-3',
    smart_format: String(opts.smartFormat),
    diarize: 'true',
    utterances: 'true',
    punctuate: 'true',
  });
  for (const t of selectKeyTerms(opts.keyTerms)) q.append('keyterm', t);
  return `${DEEPGRAM_LISTEN}?${q.toString()}`;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * How often each key term occurs in the transcript text: case-insensitive, whole words only. A
 * term with an unexpected count (a guest's name in another guest's episode) points to key-term
 * bleed, where the transcriber forced a term onto audio that doesn't contain it.
 */
export function countKeyTerms(texts: string[], terms: string[]): { term: string; count: number }[] {
  const text = texts.join('\n');
  return terms.map((term) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term)}(?![\\p{L}\\p{N}])`, 'giu');
    return { term, count: text.match(re)?.length ?? 0 };
  });
}

const MAX_DESCRIBED_KEY_TERMS = 15;

/**
 * Job-result note, e.g. "key terms: Olu Dara ×0, Tom Segura ×41, +3 more". Terms that never occur
 * come first (the useful signal); at most 15 terms are listed.
 */
export function describeKeyTermCounts(counts: { term: string; count: number }[]): string {
  if (!counts.length) return '';
  const ordered = [...counts.filter((c) => c.count === 0), ...counts.filter((c) => c.count > 0)];
  const shown = ordered.slice(0, MAX_DESCRIBED_KEY_TERMS).map((c) => `${c.term} ×${c.count}`);
  const more = ordered.length - shown.length;
  return `key terms: ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`;
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
    const detail = (await res.text().catch(() => '')).trim().slice(0, 300);
    const suffix = detail ? `: ${detail}` : '';
    // 4xx (except rate limiting / request timeout) won't succeed on retry: a bad key, unsupported
    // audio or a rejected option such as too many key terms. Fail the job at once.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
      throw new PermanentError(
        `Deepgram rejected the request (${res.status}); check the API key, the audio and the show’s transcription settings${suffix}`,
      );
    throw new Error(`Deepgram answered ${res.status}${suffix}`);
  }
  return (await res.json()) as DeepgramResponse;
}
