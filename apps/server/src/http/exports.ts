// File exports of a session. Authorization goes through the same ops as everything else.

import { formatFrames } from '@autologger/contract';
import { Hono } from 'hono';
import { HTTP_STATUS, toRpcError } from '../core/errors.ts';
import { type Actor, executeOp } from '../core/op.ts';

type Env = { Variables: { actor: Actor | null } };

// Text that a spreadsheet would read as a formula (=, +, -, @, tab, CR at the start) gets a
// leading apostrophe, so an exported message can't run as a formula when the file is opened in
// Excel or Sheets. events.importCsv strips it again (`unguardCsvCell`).
export const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const safeName = (s: string) =>
  s
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '_') || 'session';

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

export const exportRoutes = new Hono<Env>();

exportRoutes.get('/api/sessions/:sessionId/export/:format', async (c) => {
  const actor = c.get('actor');
  if (!actor)
    return c.json(
      { ok: false, error: { code: 'unauthenticated', message: 'Sign in first.' } },
      401,
    );
  const sessionId = c.req.param('sessionId');
  const format = c.req.param('format');
  const surface = actor.via === 'mcp' ? 'mcp' : 'web';
  try {
    const session = await executeOp('sessions.get', { sessionId }, actor, surface);
    const base = safeName(session.title);
    const send = (body: string, type: string, ext: string) =>
      c.body(body, 200, {
        'Content-Type': `${type}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${base}.${ext}"`,
      });

    if (format === 'events.csv' || format === 'events.jsonl') {
      const events = await executeOp('events.list', { sessionId }, actor, surface);
      if (format === 'events.jsonl')
        return send(
          events.map((e) => JSON.stringify(e)).join('\n'),
          'application/x-ndjson',
          'events.jsonl',
        );
      const header = [
        'timecode',
        'category',
        'message',
        'value',
        'take',
        'source',
        'wall_time',
        'logged_by',
      ];
      const lines = events.map((e) =>
        [
          e.timecodeFrames === null ? '' : formatFrames(e.timecodeFrames, session.frameRate),
          e.category,
          e.message,
          e.value,
          e.take,
          e.source,
          e.wallTime,
          e.createdBy?.name,
        ]
          .map(csvCell)
          .join(','),
      );
      return send([header.join(','), ...lines].join('\n'), 'text/csv', 'events.csv');
    }
    if (format === 'transcript.txt') {
      const { text } = await executeOp('transcript.text', { sessionId }, actor, surface);
      return send(text, 'text/plain', 'transcript.txt');
    }
    if (format === 'transcript.srt') {
      const segs = await executeOp('transcript.get', { sessionId }, actor, surface);
      const body = segs
        .map(
          (s, i) =>
            `${i + 1}\n${srtTime(s.startSec)} --> ${srtTime(s.endSec)}\n${s.speaker ? `${s.speaker}: ` : ''}${s.text}\n`,
        )
        .join('\n');
      return send(body, 'application/x-subrip', 'srt');
    }
    if (format === 'topics.csv') {
      const topics = await executeOp('topics.list', { sessionId }, actor, surface);
      const lines = topics.map((t) =>
        [t.startSec.toFixed(1), t.durationSec.toFixed(1), t.level, t.title, t.summary]
          .map(csvCell)
          .join(','),
      );
      return send(
        ['start_sec,duration_sec,level,title,summary', ...lines].join('\n'),
        'text/csv',
        'topics.csv',
      );
    }
    return c.json(
      { ok: false, error: { code: 'not_found', message: 'Unknown export format.' } },
      404,
    );
  } catch (e) {
    const error = toRpcError(e);
    return c.json({ ok: false, error }, HTTP_STATUS[error.code]);
  }
});
