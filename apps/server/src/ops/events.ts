import { parseTimecode, type SessionEvent, transportFrames } from '@autologger/contract';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { requireSession, type SessionRow } from '../core/authz.ts';
import { changeMessage } from '../core/bus.ts';
import { badRequest, notFound } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp, snapshot } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { iso, toEvent, userRefs } from './map.ts';
import { publishSession } from './sessions.ts';

const { events, categories } = schema;
const FREE_COLOR = '#a3a3a3';

type EventRow = typeof events.$inferSelect;

export async function eventEntities(ctx: Ctx, rows: EventRow[]): Promise<SessionEvent[]> {
  const users = await userRefs(
    ctx.db,
    rows.map((r) => r.createdBy),
  );
  return rows.map((r) => toEvent(r, users));
}

function sourceFor(ctx: Ctx): EventRow['source'] {
  if (ctx.actor.via === 'mcp') return 'agent';
  if (ctx.actor.via === 'companion') return 'companion';
  return 'operator';
}

function resolveFrames(session: SessionRow, t: { timecode?: string; atSec?: number }): number {
  if (t.timecode) {
    const f = parseTimecode(t.timecode, session.frameRate);
    if (f === null)
      throw badRequest(`Timecode ${t.timecode} is not valid at ${session.frameRate} fps.`);
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

async function insertEvent(
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

async function publishEvents(
  ctx: Ctx,
  sessionId: string,
  rows: EventRow[],
): Promise<SessionEvent[]> {
  const out = await eventEntities(ctx, rows);
  for (const e of out)
    ctx.publish(`session:${sessionId}`, changeMessage('event', 'upsert', e.id, e));
  await publishSession(ctx, sessionId);
  return out;
}

defineOp({
  name: 'events.list',
  description:
    'All events logged in a session, in timecode order. Times are frame counts on the session clock (see sessions.get for frameRate and startOffsetFrames).',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, categoryIds, source }) {
    await requireSession(ctx, sessionId, 'read');
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
    return eventEntities(ctx, rows);
  },
});

defineOp({
  name: 'events.create',
  description:
    'Log one event. Pick the button by categoryId or category name (unknown names become free labels). Place it with `timecode` (HH:MM:SS:FF on the session clock) or `atSec` (seconds from the start, which lines up with transcript times); without either it lands at the live transport position.',
  kind: 'write',
  surfaces: ['web', 'mcp', 'companion'],
  async run(ctx, { sessionId, ...input }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    const row = await insertEvent(ctx, session, input);
    const [out] = await publishEvents(ctx, sessionId, [row]);
    return out!;
  },
});

defineOp({
  name: 'events.createMany',
  description:
    'Log up to 500 events at once (same fields as events.create). Use atSec to line events up with the transcript.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { sessionId, events: list }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    const rows: EventRow[] = [];
    for (const e of list) rows.push(await insertEvent(ctx, session, e));
    return publishEvents(ctx, sessionId, rows);
  },
});

async function loadEvent(ctx: Ctx, eventId: string, need: 'read' | 'write') {
  const [row] = await ctx.db.select().from(events).where(eq(events.id, eventId));
  if (!row) throw notFound('Event');
  const { session } = await requireSession(ctx, row.sessionId, need);
  return { row, session };
}

defineOp({
  name: 'events.update',
  description: 'Edit an event’s button, message, value or time.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { eventId, categoryId, category, message, value, timecode, atSec }) {
    const { row, session } = await loadEvent(ctx, eventId, 'write');
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
    const [after] = await ctx.db.update(events).set(set).where(eq(events.id, eventId)).returning();
    await ctx.record({
      entity: 'event',
      entityId: eventId,
      kind: 'update',
      summary: `Edited ${after!.category} event`,
      showId: session.showId,
      sessionId: session.id,
      before: snapshot(row),
      after: snapshot(after),
    });
    const [out] = await publishEvents(ctx, session.id, [after!]);
    return out!;
  },
});

defineOp({
  name: 'events.delete',
  description: 'Delete an event (it can be restored from the change log).',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { eventId }) {
    const { row, session } = await loadEvent(ctx, eventId, 'write');
    await ctx.db.delete(events).where(eq(events.id, eventId));
    await ctx.record({
      entity: 'event',
      entityId: eventId,
      kind: 'delete',
      summary: `Deleted ${row.category} event`,
      showId: session.showId,
      sessionId: session.id,
      before: snapshot(row),
    });
    ctx.publish(`session:${session.id}`, changeMessage('event', 'delete', eventId));
    await publishSession(ctx, session.id);
    return { deleted: true };
  },
});

/** Minimal RFC 4180 CSV parser. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

defineOp({
  name: 'events.importCsv',
  description:
    'Import events from CSV with columns timecode, category, message and optional value (header row optional). Rows with a bad timecode are skipped and reported.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { sessionId, csv }) {
    const { session } = await requireSession(ctx, sessionId, 'write');
    const rows = parseCsv(csv);
    let start = 0;
    let cols = { timecode: 0, category: 1, message: 2, value: 3 };
    const header = rows[0]?.map((h) => h.trim().toLowerCase());
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
      const r = rows[i]!;
      const tc = r[cols.timecode]?.trim() ?? '';
      const category = r[cols.category]?.trim() ?? '';
      if (parseTimecode(tc, session.frameRate) === null) {
        skipped.push({ line: i + 1, reason: `bad timecode “${tc}”` });
        continue;
      }
      if (!category) {
        skipped.push({ line: i + 1, reason: 'missing category' });
        continue;
      }
      inserted.push(
        await insertEvent(
          ctx,
          session,
          {
            timecode: tc,
            category,
            message: r[cols.message] ?? '',
            value: r[cols.value]?.trim() || null,
          },
          'import',
        ),
      );
    }
    ctx.publish(`session:${sessionId}`, { type: 'invalidate', entity: 'event' });
    await publishSession(ctx, sessionId);
    return { imported: inserted.length, skipped };
  },
});
