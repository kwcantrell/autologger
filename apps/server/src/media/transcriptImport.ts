// Parsing of transcripts imported with transcript.import: JSON segment lists, SubRip (SRT) and
// WebVTT. Pure functions; errors are bad_request with the cue or item that failed.

import { MAX_TRANSCRIPT_IMPORT_SEGMENTS } from '@autologger/contract';
import { badRequest } from '../core/errors.ts';

export interface ImportedSegment {
  /** Seconds from the start of the file (the caller adds the audio segment offset). */
  startSec: number;
  endSec: number;
  speaker: string;
  text: string;
}

export type ImportFormat = 'json' | 'srt' | 'vtt';

const MAX_TEXT = 20000;
const MAX_SPEAKER = 80;
const MAX_SEC = 7 * 24 * 3600;

/** `HH:MM:SS,mmm` / `HH:MM:SS.mmm` / `MM:SS.mmm` (hours optional, 0-3 fraction digits). */
const TIME = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/;

export function parseTimestamp(raw: string): number | null {
  const m = TIME.exec(raw.trim());
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  if (Number(mm) > 59 || Number(ss) > 59) return null;
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  return Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss) + ms / 1000;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '',
  rlm: '',
};

/** Strip formatting tags (`<i>`, `<c.x>`, `<00:00:01.000>`, `{\an8}`) and decode entities. */
function cleanText(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A leading speaker label: `Name: text`, `>> Name: text` or `[Name] text`. A label is 1-4 words,
 * each starting with a capital letter or digit ("Dana", "Speaker 1", "Dr. Jane Smith",
 * "SPEAKER_00"), so prose like "the answer is: yes" or times like "at 10:30" don't match.
 */
const SPEAKER_PREFIX = /^(?:>>\s*)?([\p{L}\p{N}_.'’ -]{1,40}?)\s*:\s+(?=\S)/u;
const BRACKET_PREFIX = /^\[([\p{L}\p{N}_.'’ -]{1,40}?)\]\s*(?=\S)/u;

const isLabel = (s: string) => {
  const words = s.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 4 && words.every((w) => /^[\p{Lu}\p{N}]/u.test(w));
};

function splitSpeaker(line: string): { speaker?: string; text: string } {
  const m = SPEAKER_PREFIX.exec(line) ?? BRACKET_PREFIX.exec(line);
  const text = line.replace(/^>>\s*/, '');
  if (!m || !isLabel(m[1]!.trim())) return { text };
  return { speaker: m[1]!.trim(), text: line.slice(m[0].length) };
}

/** Lines of a cue's payload → speaker (VTT `<v Name>` or a `Name:` prefix) and text. */
function cueBody(lines: string[]): { speaker?: string; text: string } {
  let speaker: string | undefined;
  const parts: string[] = [];
  for (const raw of lines) {
    const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/i.exec(raw);
    if (voice && speaker === undefined) speaker = cleanText(voice[1]!);
    let line = cleanText(raw);
    if (!line) continue;
    if (!voice && parts.length === 0) {
      const s = splitSpeaker(line);
      if (s.speaker !== undefined && speaker === undefined) speaker = s.speaker;
      line = s.text;
    }
    parts.push(line);
  }
  return { speaker, text: parts.join(' ').trim() };
}

const ARROW = /^\s*(\S+)\s+-->\s+(\S+)(?:\s.*)?$/;

/** SRT and WebVTT: blocks separated by blank lines, each with a `start --> end` line. */
function parseCues(content: string, format: 'srt' | 'vtt'): ImportedSegment[] {
  const text = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  let i = 0;
  if (format === 'vtt') {
    if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0]?.trim() ?? ''))
      throw badRequest('A WebVTT file must start with the line "WEBVTT".');
    // Skip the header block.
    while (i < lines.length && lines[i]!.trim() !== '') i++;
  }
  const out: ImportedSegment[] = [];
  let lastSpeaker = '';
  let cue = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trim() === '') i++;
    if (i >= lines.length) break;
    const block: { line: number; text: string }[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') {
      block.push({ line: i + 1, text: lines[i]! });
      i++;
    }
    const first = block[0]!.text.trim();
    if (format === 'vtt' && /^(NOTE|STYLE|REGION)(?:\s|$)/.test(first)) continue;
    const at = block.findIndex((b) => b.text.includes('-->'));
    // SRT: an index line then the timing line; VTT: an optional identifier then the timing line.
    if (at < 0 || at > 1) {
      throw badRequest(
        `Line ${block[0]!.line}: expected a cue timing line like "00:00:01,000 --> 00:00:04,000" but found "${first.slice(0, 80)}".`,
      );
    }
    cue++;
    const timing = block[at]!;
    const m = ARROW.exec(timing.text);
    const start = m ? parseTimestamp(m[1]!) : null;
    const end = m ? parseTimestamp(m[2]!) : null;
    if (start === null || end === null)
      throw badRequest(
        `Line ${timing.line}: bad cue timing "${timing.text.trim().slice(0, 80)}" (expected HH:MM:SS,mmm --> HH:MM:SS,mmm).`,
      );
    if (end < start)
      throw badRequest(`Line ${timing.line}: cue ends (${m![2]}) before it starts (${m![1]}).`);
    const body = cueBody(block.slice(at + 1).map((b) => b.text));
    if (!body.text) continue;
    if (body.speaker !== undefined) lastSpeaker = body.speaker;
    out.push(
      checked(
        { startSec: start, endSec: end, speaker: lastSpeaker, text: body.text },
        `Line ${timing.line}`,
      ),
    );
    if (out.length > MAX_TRANSCRIPT_IMPORT_SEGMENTS) tooMany();
  }
  if (cue === 0) throw badRequest(`No cues found in this ${format.toUpperCase()} file.`);
  return out;
}

function tooMany(): never {
  throw badRequest(
    `At most ${MAX_TRANSCRIPT_IMPORT_SEGMENTS} segments per import; split the transcript and import the rest with mode "append".`,
  );
}

function checked(seg: ImportedSegment, where: string): ImportedSegment {
  if (seg.endSec > MAX_SEC) throw badRequest(`${where}: times must be under 7 days.`);
  if (seg.text.length > MAX_TEXT)
    throw badRequest(`${where}: text is over ${MAX_TEXT} characters; split it into shorter cues.`);
  if (seg.speaker.length > MAX_SPEAKER)
    throw badRequest(`${where}: speaker is over ${MAX_SPEAKER} characters.`);
  return seg;
}

function parseJson(content: string): ImportedSegment[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (e) {
    throw badRequest(`content is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(data))
    throw badRequest('JSON content must be an array of { startSec, endSec, speaker, text }.');
  if (data.length > MAX_TRANSCRIPT_IMPORT_SEGMENTS) tooMany();
  const out: ImportedSegment[] = [];
  for (const [i, item] of data.entries()) {
    const where = `Item ${i}`;
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw badRequest(`${where}: expected an object { startSec, endSec, speaker, text }.`);
    const { startSec, endSec, speaker, text } = item as Record<string, unknown>;
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (!num(startSec) || !num(endSec))
      throw badRequest(`${where}: startSec and endSec must be numbers of seconds ≥ 0.`);
    if ((endSec as number) < (startSec as number))
      throw badRequest(`${where}: endSec is before startSec.`);
    if (typeof text !== 'string') throw badRequest(`${where}: text must be a string.`);
    if (speaker !== undefined && speaker !== null && typeof speaker !== 'string')
      throw badRequest(`${where}: speaker must be a string.`);
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    out.push(
      checked(
        {
          startSec: startSec as number,
          endSec: endSec as number,
          speaker: ((speaker as string | null | undefined) ?? '').trim(),
          text: clean,
        },
        where,
      ),
    );
  }
  return out;
}

/** Parse an import into segments sorted by start time; at least one segment, else bad_request. */
export function parseTranscript(format: ImportFormat, content: string): ImportedSegment[] {
  const segs = format === 'json' ? parseJson(content) : parseCues(content, format);
  if (segs.length === 0) throw badRequest('The transcript has no segments with text.');
  return segs
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.startSec - b.s.startSec || a.i - b.i)
    .map(({ s }) => s);
}
