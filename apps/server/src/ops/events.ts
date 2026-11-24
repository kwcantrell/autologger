import {
  type CompactEventsAck,
  formatFrames,
  formatIssues,
  opInputs,
  parseTimecode,
  type SessionEvent,
  transportFrames,
} from '@autologger/contract';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { requireSession, type SessionRow } from '../core/authz.ts';
import { changeMessage } from '../core/bus.ts';
import { AppError, badRequest, notFound } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp, snapshot } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { iso, toEvent, userRefs } from './map.ts';
import { publishSession } from './sessions.ts';

const { events, categories } = schema;
const FREE_COLOR = '#a3a3a3';

type EventRow = typeof events.$inferSelect;

/** `session` supplies the clock (frameRate, startOffsetFrames) used to derive each event's atSec. */
export async function eventEntities(
  ctx: Ctx,
  session: SessionRow,
  rows: EventRow[],
): Promise<SessionEvent[]> {
  const users = await userRefs(
    ctx.db,
    rows.map((r) => r.createdBy),
  );
  return rows.map((r) => toEvent(r, users, session));
}

function sourceFor(ctx: Ctx): EventRow['source'] {
  if (ctx.actor.via === 'mcp') return 'agent';
  if (ctx.actor.via === 'companion') return 'companion';
  return 'operator';
}

/**
 * A timecode's frame count on the session clock, or why it cannot place an event: it must be
 * valid at the session's frame rate and not before the start timecode (atSec >= 0).
 */
function timecodeFrames(session: SessionRow, timecode: string): number | string {
  const f = parseTimecode(timecode, session.frameRate);
  if (f === null) return `Timecode ${timecode} is not valid at ${session.frameRate} fps.`;
  if (f < session.startOffsetFrames)
    return `Timecode ${timecode} is before the session start timecode ${formatFrames(session.startOffsetFrames, session.frameRate)}.`;
  return f;
}

function resolveFrames(session: SessionRow, t: { timecode?: string; atSec?: number }): number {
  if (t.timecode) {
    const f = timecodeFrames(session, t.timecode);
    if (typeof f === 'string') throw badRequest(f);
    return f;
  }
  if (t.atSec !== undefined)
    return session.startOffsetFrames + Math.round(t.atSec * session.frameRate);
  return transportFrames({
    isRolling: session.isRolling,
    rollStartedAt: iso(session.rollStartedAt),
    elapsedFrames: session.elapsedFrames,
    take: session.take,
    frameRate: session.frameRate,
    startOffsetFrames: session.startOffsetFrames,
  });
}

async function resolveCategory(
  ctx: Ctx,
  showId: string,
  input: { categoryId?: string | null; category?: string },
): Promise<{ categoryId: string | null; category: string; color: string }> {
  if (input.categoryId) {
    const [c] = await ctx.db
      .select()
      .from(categories)
      .where(and(eq(categories.id, input.categoryId), eq(categories.showId, showId)));
    if (!c) throw notFound('Event button');
    return { categoryId: c.id, category: c.name, color: c.color };
  }
  const label = input.category?.trim();
  if (!label) throw badRequest('Give a categoryId or a category name.');
  const [c] = await ctx.db
    .select()
    .from(categories)
    .where(and(eq(categories.showId, showId), sql`lower(${categories.name}) = lower(${label})`));
  return c
    ? { categoryId: c.id, category: c.name, color: c.color }
    : { categoryId: null, category: label, color: FREE_COLOR };
}

type EventInput = {
  categoryId?: string;
  category?: string;
  message?: string;
  value?: string | null;
  timecode?: string;
  atSec?: number;
};

/** Insert one event and record its creation (undo deletes it). Also used by compilations.create. */
export async function insertEvent(
  ctx: Ctx,
  session: SessionRow,
  input: EventInput,
  source = sourceFor(ctx),
): Promise<EventRow> {
  const cat = await resolveCategory(ctx, session.showId, input);
  const [row] = await ctx.db
    .insert(events)
    .values({
      id: newId('evt'),
      sessionId: session.id,
      ...cat,
      message: input.message ?? '',
      value: input.value ?? null,
      timecodeFrames: resolveFrames(session, input),
      take: session.take,
      source,
      createdBy: ctx.actor.user.id,
    })
    .returning();
  await ctx.record({
    entity: 'event',
    entityId: row!.id,
    kind: 'create',
    summary: `Logged ${cat.category}${input.message ? `: ${input.message.slice(0, 80)}` : ''}`,
    showId: session.showId,
    sessionId: session.id,
    after: snapshot(row),
  });
  return row!;
}

/** Publish created or updated events to the session's socket (after commit). */
export async function publishEvents(
  ctx: Ctx,
  session: SessionRow,
  rows: EventRow[],
): Promise<SessionEvent[]> {
  const out = await eventEntities(ctx, session, rows);
  for (const e of out)
    ctx.publish(`session:${session.id}`, changeMessage('event', 'upsert', e.id, e));
  await publishSession(ctx, session.id);
  return out;
}

defineOp({
  name: 'events.list',
  description:
    'All events logged in a session, in timecode order. Each event has `atSec` (seconds from the session start, rounded to ms; lines up with transcript_text @seconds and is the same value events_create/update accept as atSec) and `timecodeFrames` (frame count on the session clock, including startOffsetFrames — see sessions_get for frameRate). atSec is null only when the event has no timecode. Agents get `[{ id, atSec, category, message }]` per event by default (compact); pass `compact: false` for full events.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, categoryIds, source, compact }) {
    const { session } = await requireSession(ctx, sessionId, 'read');
    const rows = await ctx.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.sessionId, sessionId),
          categoryIds?.length ? inArray(events.categoryId, categoryIds) : undefined,
          source ? eq(events.source, source) : undefined,
        ),
      )
      .orderBy(asc(events.timecodeFrames), asc(events.createdAt));
    const out = await eventEntities(ctx, session, rows);
    return compact
      ? out.map(({ id, atSec, category, message }) => ({ id, atSec, category, message }))
      : out;
  },
});

defineOp({
  name: 'events.create',
  description:
    'Log one event. Pick the button by categoryId or category name (case-insensitive; button names in sessions_get categories — unknown names become free labels). Place it with `timecode` (HH:MM:SS:FF on the session clock) or `atSec` (seconds from the start, which lines up with transcript times); without either it lands at the live transport position. Times are stored as whole frames: atSec snaps to the nearest frame of the session’s frame rate (frameRate in sessions_get; at 30 fps 69.975 → 69.967), and the returned atSec (rounded to ms, as in events_list) is the stored value. A timecode before the session start timecode (sessions_get) is refused with bad_request, like a negative atSec.',
  kind: 'write',
  surfaces: ['web', 'mcp', 'companion'],
  async run(ctx, { sessionId, ...input }) {
    const { session } = await requireSession(ctx, sessionId, 'write', 'share');
    const row = await insertEvent(ctx, session, input);
    const [out] = await publishEvents(ctx, session, [row]);
    return out!;
  },
});

defineOp({
  name: 'events.createMany',
  description:
    '`events`: up to 500 items, each with the fields of events_create — logs them in one session (sessionId) at once. All-or-nothing: an invalid item (e.g. a timecode before the session start) fails the whole call with bad_request naming its index. Use atSec to line events up with the transcript; it snaps to the session’s frame grid like events_create (by at most half a frame). Agents get `{ ids, freeLabels }` by default (compact): the new event ids in input order, and `[{ category, indexes }]` for each category name that matched no button of the show and so became a free label, with the input indexes that used it (intended, or fix them with events_updateMany); stored atSec values are in events_list. Pass `compact: false` for the created events.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, events: list, compact }) {
    const { session } = await requireSession(ctx, sessionId, 'write', 'share');
    const rows: EventRow[] = [];
    for (const [i, e] of list.entries())
      rows.push(await atItem(i, () => insertEvent(ctx, session, e)));
    const out = await publishEvents(ctx, session, rows);
    return compact ? eventsAck(rows, (_, row) => row.categoryId === null) : out;
  },
});

/**
 * The compact acknowledgement of a bulk event write: ids in input order, plus the input indexes
 * whose button name became a free label (`isFree(i, row)`), grouped by that name.
 */
function eventsAck(
  rows: EventRow[],
  isFree: (i: number, row: EventRow) => boolean,
): CompactEventsAck {
  const free = new Map<string, number[]>();
  for (const [i, r] of rows.entries())
    if (isFree(i, r)) free.set(r.category, [...(free.get(r.category) ?? []), i]);
  return {
    ids: rows.map((r) => r.id),
    freeLabels: [...free].map(([category, indexes]) => ({ category, indexes })),
  };
}

/** Run one item of a bulk write; a bad_request names the item (`events[3]: …`). */
async function atItem<T>(i: number, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError && e.code === 'bad_request')
      throw badRequest(`events[${i}]: ${e.message}`);
    throw e;
  }
}

async function loadEvent(ctx: Ctx, eventId: string, need: 'read' | 'write') {
  const [found] = await ctx.db.select().from(events).where(eq(events.id, eventId));
  if (!found) throw notFound('Event');
  if (need === 'read') return { row: found, ...(await requireSession(ctx, found.sessionId, need)) };
  // Writes hold the session clock, then re-read the row: a clock change may have retimed it.
  const { session } = await requireSession(ctx, found.sessionId, need, 'share');
  const [row] = await ctx.db.select().from(events).where(eq(events.id, eventId));
  if (!row) throw notFound('Event');
  return { row, session };
}

type EventPatch = {
  categoryId?: string | null;
  category?: string;
  message?: string;
  value?: string | null;
  timecode?: string;
  atSec?: number;
};

/** Apply one event edit and record it in the change log (before/after) for undo. */
async function updateEventRow(
  ctx: Ctx,
  session: SessionRow,
  row: EventRow,
  { categoryId, category, message, value, timecode, atSec }: EventPatch,
): Promise<EventRow> {
  const set: Partial<typeof events.$inferInsert> = { updatedAt: new Date() };
  if (categoryId !== undefined || category !== undefined) {
    Object.assign(
      set,
      await resolveCategory(ctx, session.showId, {
        categoryId,
        category: category ?? row.category,
      }),
    );
  }
  if (message !== undefined) set.message = message;
  if (value !== undefined) set.value = value;
  if (timecode !== undefined || atSec !== undefined)
    set.timecodeFrames = resolveFrames(session, { timecode, atSec });
  const [after] = await ctx.db.update(events).set(set).where(eq(events.id, row.id)).returning();
  await ctx.record({
    entity: 'event',
    entityId: row.id,
    kind: 'update',
    summary: `Edited ${after!.category} event`,
    showId: session.showId,
    sessionId: session.id,
    before: snapshot(row),
    after: snapshot(after),
  });
  return after!;
}

defineOp({
  name: 'events.update',
  description:
    'Edit an event’s button, message, value or time (`atSec` in seconds from the session start, or `timecode` on the session clock; a timecode before the session start timecode is refused with bad_request). atSec snaps to the nearest frame of the session’s frame rate, as in events_create.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { eventId, ...patch }) {
    const { row, session } = await loadEvent(ctx, eventId, 'write');
    const after = await updateEventRow(ctx, session, row, patch);
    const [out] = await publishEvents(ctx, session, [after]);
    return out!;
  },
});

defineOp({
  name: 'events.updateMany',
  description:
    '`events`: up to 500 items, each `{ id, …fields to change }` — edits events of one session (sessionId) in one call. Each item is { id (event id from events_list), and only the fields to change: categoryId | category (button), message, value, atSec (seconds from the session start, as in transcript_text; snaps to the session’s frame grid as in events_create) | timecode }; omitted fields stay as they are. All-or-nothing: an unknown id or an event from another session fails the whole call with nothing changed. Each edit is its own entry in the change log, so it can be undone per event. Agents get `{ ids, freeLabels }` by default (compact): ids in input order, and `[{ category, indexes }]` for new category names that matched no button and became free labels. Pass `compact: false` for the updated events.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, events: list, compact }) {
    const { session } = await requireSession(ctx, sessionId, 'write', 'share');
    const ids = list.map((e) => e.id);
    if (new Set(ids).size !== ids.length) throw badRequest('Each event id may appear only once.');
    const rows = await ctx.db
      .select()
      .from(events)
      .where(and(eq(events.sessionId, sessionId), inArray(events.id, ids)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.filter((i) => !byId.has(i));
    if (missing.length)
      throw notFound(
        `Event${missing.length > 1 ? 's' : ''} ${missing.slice(0, 10).join(', ')} in this session`,
      );
    const updated: EventRow[] = [];
    for (const [i, { id, ...patch }] of list.entries())
      updated.push(await atItem(i, () => updateEventRow(ctx, session, byId.get(id)!, patch)));
    const out = await publishEvents(ctx, session, updated);
    if (!compact) return out;
    // Only an edit that set the button can have turned it into a free label.
    return eventsAck(
      updated,
      (i, row) =>
        row.categoryId === null &&
        (list[i]!.category !== undefined || list[i]!.categoryId !== undefined),
    );
  },
});

/**
 * Delete one event, record it (undo restores it) and publish the deletion. The caller publishes
 * the session summary (publishSession) once. Also used by compilations.delete.
 */
export async function deleteEvent(ctx: Ctx, session: SessionRow, row: EventRow): Promise<void> {
  await ctx.db.delete(events).where(eq(events.id, row.id));
  await ctx.record({
    entity: 'event',
    entityId: row.id,
    kind: 'delete',
    summary: `Deleted ${row.category} event`,
    showId: session.showId,
    sessionId: session.id,
    before: snapshot(row),
  });
  ctx.publish(`session:${session.id}`, changeMessage('event', 'delete', row.id));
}

defineOp({
  name: 'events.delete',
  description: 'Delete an event (it can be restored from the change log).',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { eventId }) {
    const { row, session } = await loadEvent(ctx, eventId, 'write');
    await deleteEvent(ctx, session, row);
    await publishSession(ctx, session.id);
    return { deleted: true };
  },
});

/**
 * Minimal RFC 4180 CSV parser. Blank rows are dropped; each row keeps the 1-based line of the
 * file it starts on (quoted fields may span lines), for error reports.
 */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        field += ch;
        // A line break inside a quoted field (\r\n counts once).
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++;
      }
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      line++;
      row.push(field);
      rows.push({ line: rowLine, cells: row });
      row = [];
      field = '';
      rowLine = line;
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push({ line: rowLine, cells: row });
  }
  return rows.filter((r) => r.cells.some((c) => c.trim()));
}

/** The text fields of a CSV row, with the same limits as events.create. */
const csvRowFields = opInputs['events.create'].pick({ category: true, message: true, value: true });

/** Undo the export's formula guard: `'=x` → `=x` (only before a formula-start character). */
export const unguardCsvCell = (s: string) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);

defineOp({
  name: 'events.importCsv',
  description:
    'Import events from CSV with columns timecode, category, message and optional value (header row optional). Rows with a bad timecode, a timecode before the session start timecode, a missing category or text over the events.create limits (category 60, message 5000, value 200 characters) are skipped and reported with their line in the file.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { sessionId, csv }) {
    const { session } = await requireSession(ctx, sessionId, 'write', 'share');
    const rows = parseCsv(csv);
    let start = 0;
    let cols = { timecode: 0, category: 1, message: 2, value: 3 };
    const header = rows[0]?.cells.map((h) => h.trim().toLowerCase());
    if (header?.includes('timecode') || header?.includes('category')) {
      const idx = (n: string, d: number) => (header.indexOf(n) >= 0 ? header.indexOf(n) : d);
      cols = {
        timecode: idx('timecode', 0),
        category: idx('category', 1),
        message: idx('message', 2),
        value: idx('value', 3),
      };
      start = 1;
    }
    const skipped: { line: number; reason: string }[] = [];
    const inserted: EventRow[] = [];
    for (let i = start; i < rows.length; i++) {
      const { line, cells: r } = rows[i]!;
      const tc = r[cols.timecode]?.trim() ?? '';
      const category = unguardCsvCell(r[cols.category]?.trim() ?? '');
      const frames = parseTimecode(tc, session.frameRate);
      if (frames === null) {
        skipped.push({ line, reason: `bad timecode “${tc}”` });
        continue;
      }
      if (frames < session.startOffsetFrames) {
        const start = formatFrames(session.startOffsetFrames, session.frameRate);
        skipped.push({
          line,
          reason: `timecode “${tc}” is before the session start ${start}`,
        });
        continue;
      }
      if (!category) {
        skipped.push({ line, reason: 'missing category' });
        continue;
      }
      const fields = csvRowFields.safeParse({
        category,
        message: unguardCsvCell(r[cols.message] ?? ''),
        value: unguardCsvCell(r[cols.value]?.trim() ?? '') || null,
      });
      if (!fields.success) {
        const [issue] = formatIssues(fields.error.issues);
        skipped.push({ line, reason: `${issue!.path}: ${issue!.message}` });
        continue;
      }
      inserted.push(await insertEvent(ctx, session, { timecode: tc, ...fields.data }, 'import'));
    }
    ctx.publish(`session:${sessionId}`, { type: 'invalidate', entity: 'event' });
    await publishSession(ctx, sessionId);
    return { imported: inserted.length, skipped };
  },
});
