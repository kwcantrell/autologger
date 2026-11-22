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
 *
 * Diarization uses `diarize_model=latest` (for pre-recorded audio currently Deepgram's v2
 * diarizer): the older boolean `diarize=true` is deprecated and always runs the v1 diarizer, the one
 * in use when two-person interviews came back with merged and swapped speakers (#169). Deepgram takes no speaker-count
 * hint; a speaker change inside an utterance is split at word level by `mapDeepgram`.
 */
export function deepgramUrl(opts: TranscriptionOptions = DEFAULT_TRANSCRIPTION_OPTIONS): string {
  const q = new URLSearchParams({
    model: 'nova-3',
    smart_format: String(opts.smartFormat),
    diarize_model: 'latest',
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

/**
 * Job-result note naming the diarizer and transcription model Deepgram reports it ran, e.g.
 * "diarizer v2 · nova-3 2025-04-17" (#208), so a transcript with merged or swapped speakers can be
 * traced to the diarizer that produced it. The model is `metadata.models[0]` looked up in
 * `metadata.model_info` (keyed by model uuid); its version drops Deepgram's ".<build>" suffix.
 * Either part is left out when Deepgram doesn't report it; '' when neither is.
 */
export function describeTranscriber(resp: DeepgramResponse): string {
  const meta = resp.metadata;
  const arch = meta?.diarize_info?.arch;
  const info = meta?.model_info ?? {};
  const uuid =
    meta?.models?.find((id) => info[id]) ??
    Object.keys(info).find((id) => id !== meta?.diarize_info?.model_uuid);
  const model = uuid ? info[uuid] : undefined;
  const modelName = [model?.arch ?? model?.name, model?.version?.split('.')[0]]
    .filter(Boolean)
    .join(' ');
  return [arch && `diarizer ${arch}`, modelName].filter(Boolean).join(' · ');
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
  metadata?: {
    duration?: number;
    /** Present only when a diarizer ran; `arch` is the family `diarize_model` resolved to ("v1", "v2"). */
    diarize_info?: { model_uuid?: string; arch?: string };
    /** uuids of the transcription models that ran, keys into `model_info`. */
    models?: string[];
    /** Per model uuid, e.g. { name: "general-nova-3", version: "2025-04-17.21547", arch: "nova-3" }. */
    model_info?: Record<string, { name?: string; version?: string; arch?: string }>;
  };
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

/** A word-level speaker run this short (≤ 2 words and under 0.3 s) is a diarization blip. */
const BLIP_MAX_WORDS = 2;
const BLIP_MAX_SEC = 0.3;

interface SpeakerRun {
  speaker: number | undefined;
  words: DeepgramWord[];
}

/**
 * Split a word list into runs of one speaker each. Deepgram utterances can span a speaker change
 * (a question and its answer in one utterance) while every word still carries its own `speaker`.
 * Short runs (≤ 2 words under 0.3 s) take the previous run's speaker (the next run's at the
 * start), so one mislabelled word doesn't cut a sentence in three.
 */
export function speakerRuns(words: DeepgramWord[], fallback: number | undefined): SpeakerRun[] {
  const raw: SpeakerRun[] = [];
  for (const w of words) {
    const sp = w.speaker ?? fallback;
    const last = raw.at(-1);
    if (last && last.speaker === sp) last.words.push(w);
    else raw.push({ speaker: sp, words: [w] });
  }
  if (raw.length < 2) return raw;
  const isBlip = (r: SpeakerRun) =>
    r.words.length <= BLIP_MAX_WORDS && r.words.at(-1)!.end - r.words[0]!.start < BLIP_MAX_SEC;
  const out: SpeakerRun[] = [];
  raw.forEach((r, i) => {
    const sp = isBlip(r) ? (out.at(-1)?.speaker ?? raw[i + 1]!.speaker) : r.speaker;
    const last = out.at(-1);
    if (last && last.speaker === sp) last.words.push(...r.words);
    else out.push({ speaker: sp, words: [...r.words] });
  });
  return out;
}

/**
 * Map Deepgram utterances to transcript rows, offset to session time by `offsetSec`. An utterance
 * whose words change speaker becomes one row per speaker run (see speakerRuns).
 */
export function mapDeepgram(resp: DeepgramResponse, offsetSec: number): MappedSegment[] {
  const mapWords = (ws: DeepgramWord[]): TranscriptWord[] =>
    ws.map((w) => ({
      w: w.punctuated_word ?? w.word,
      s: r3(w.start + offsetSec),
      e: r3(w.end + offsetSec),
      ...(typeof w.speaker === 'number' ? { sp: w.speaker } : {}),
    }));

  // Without a speaker change a row keeps the utterance's own span, speaker and transcript text
  // (Deepgram's smart-format spacing for numbers and currency stays intact). Only split rows
  // rebuild their text by joining punctuated words, and take their words' span (the outer edges
  // keep the utterance bounds).
  const toRows = (
    start: number,
    end: number,
    text: string,
    speaker: number | undefined,
    words: DeepgramWord[],
  ): MappedSegment[] => {
    const runs = speakerRuns(words, speaker);
    if (runs.length < 2)
      return [
        {
          startSec: r3(start + offsetSec),
          endSec: r3(end + offsetSec),
          speaker: speakerLabel(speaker ?? runs[0]?.speaker),
          text,
          words: mapWords(words),
        },
      ];
    return runs.map((run, i) => ({
      startSec: r3((i === 0 ? start : run.words[0]!.start) + offsetSec),
      endSec: r3((i === runs.length - 1 ? end : run.words.at(-1)!.end) + offsetSec),
      speaker: speakerLabel(run.speaker),
      text: run.words.map((w) => w.punctuated_word ?? w.word).join(' '),
      words: mapWords(run.words),
    }));
  };

  const utterances = resp.results?.utterances ?? [];
  if (utterances.length > 0) {
    return utterances
      .filter((u) => u.transcript.trim().length > 0)
      .sort((a, b) => a.start - b.start)
      .flatMap((u) => toRows(u.start, u.end, u.transcript.trim(), u.speaker, u.words ?? []));
  }
  // No utterances (e.g. silence or an older response shape): fall back to the channel transcript,
  // also split where the word-level speaker changes.
  const alt = resp.results?.channels?.[0]?.alternatives?.[0];
  const text = alt?.transcript?.trim();
  if (!alt || !text) return [];
  const words = alt.words ?? [];
  return toRows(
    words[0]?.start ?? 0,
    words.at(-1)?.end ?? resp.metadata?.duration ?? 0,
    text,
    words[0]?.speaker,
    words,
  );
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
