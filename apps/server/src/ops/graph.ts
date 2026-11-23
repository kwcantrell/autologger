// The show knowledge graph: a read-only projection of what AutoLogger already stores — sessions,
// wiki pages with their [[links]], aliases and citations, topics and events — into entities,
// relations and "moments" (clip-ready session ranges tagged with the entities they are about).
// Nothing here is stored: every call reads the current data, so it never drifts from the wiki.

import {
  type CompactMoment,
  framesToAtSec,
  type GraphEntity,
  MAX_CLIP_SEC,
  MIN_CLIP_SEC,
  type Moment,
  type MomentClip,
  type MomentEntity,
  normTitle,
  plainText,
  type WikiKind,
  wikiBlocks,
  wikiSections,
} from '@autologger/contract';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { requireShow } from '../core/authz.ts';
import { notFound } from '../core/errors.ts';
import { type Ctx, defineOp } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { env } from '../env.ts';
import { firstParagraph } from './wiki.ts';

const { wikiPages: pages, sessions, topics, events, transcriptSegments: segments } = schema;

interface SessionInfo {
  id: string;
  title: string;
  episode: string;
  episodeDate: string | null;
  /** Episode date, or the creation instant — the same "sessionDate" search returns. */
  date: string;
  /** Position in episode order (episode number when every session has one, else date; then title). */
  order: number;
  frameRate: number;
  startOffsetFrames: number;
}

interface PageInfo {
  id: string;
  title: string;
  kind: WikiKind;
  aliases: string[];
  bodyMd: string;
  sessionId: string | null;
  revision: number;
  updatedAt: string;
}

interface Knowledge {
  show: { id: string; name: string; code: string };
  sessions: Map<string, SessionInfo>;
  pages: Map<string, PageInfo>;
  /** Normalised title or alias → page id (titles win over aliases). */
  names: Map<string, string>;
  /** Every citation of a session of this show, as a moment (rank 0). */
  citations: Moment[];
}

const entityOf = (p: PageInfo): MomentEntity => ({ pageId: p.id, title: p.title, kind: p.kind });

async function loadKnowledge(ctx: Ctx, showId: string): Promise<Knowledge> {
  const { show } = await requireShow(ctx, showId, 'read');
  const sessionRows = await ctx.db
    .select({
      id: sessions.id,
      title: sessions.title,
      episode: sessions.episode,
      episodeDate: sessions.episodeDate,
      createdAt: sessions.createdAt,
      frameRate: sessions.frameRate,
      startOffsetFrames: sessions.startOffsetFrames,
    })
    .from(sessions)
    .where(eq(sessions.showId, showId));
  const withDate = sessionRows.map((s) => ({
    ...s,
    date: s.episodeDate ?? s.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }));
  // Episode numbers when every session has one (dates are often import dates), else the date.
  const numbered = withDate.every((s) => /^\d+$/.test(s.episode.trim()));
  withDate.sort(
    (a, b) =>
      (numbered ? Number(a.episode) - Number(b.episode) : 0) ||
      a.date.localeCompare(b.date) ||
      a.title.localeCompare(b.title, undefined, { numeric: true }) ||
      a.id.localeCompare(b.id),
  );
  const sessionMap = new Map<string, SessionInfo>(
    withDate.map((s, i) => [
      s.id,
      {
        id: s.id,
        title: s.title,
        episode: s.episode,
        episodeDate: s.episodeDate,
        date: s.date,
        order: i,
        frameRate: s.frameRate,
        startOffsetFrames: s.startOffsetFrames,
      },
    ]),
  );

  const pageRows = await ctx.db
    .select()
    .from(pages)
    .where(and(eq(pages.showId, showId), isNull(pages.deletedAt)))
    .orderBy(asc(pages.kind), asc(pages.title));
  const pageMap = new Map<string, PageInfo>(
    pageRows.map((p) => [
      p.id,
      {
        id: p.id,
        title: p.title,
        kind: p.kind,
        aliases: p.aliases,
        bodyMd: p.bodyMd,
        sessionId: p.sessionId,
        revision: p.revision,
        updatedAt: p.updatedAt.toISOString(),
      },
    ]),
  );
  const names = new Map<string, string>();
  for (const p of pageMap.values()) names.set(normTitle(p.title), p.id);
  for (const p of pageMap.values())
    for (const a of p.aliases) if (!names.has(normTitle(a))) names.set(normTitle(a), p.id);

  const citations: Moment[] = [];
  for (const page of pageMap.values()) {
    let ord = 0;
    for (const block of wikiBlocks(page.bodyMd, page.sessionId)) {
      // A table row is read cell by cell even with one citation: a guide row's citation is about
      // its row's subject and its own cell, not every page linked in the other columns.
      const several = block.claims.length > 1 || block.markdown.trimStart().startsWith('|');
      for (const { citation: c, text, links } of block.claims) {
        ord++;
        const s = sessionMap.get(c.sessionId);
        if (!s) continue;
        // The claim's own sentence and links; a block with one citation is one claim.
        const linked = (several ? links : block.links)
          .map((t) => names.get(normTitle(t)))
          .filter((id): id is string => Boolean(id) && id !== page.id);
        citations.push({
          kind: 'citation',
          id: `${page.id}#${ord}`,
          sessionId: s.id,
          sessionTitle: s.title,
          sessionDate: s.date,
          startSec: c.startSec,
          endSec: c.endSec !== undefined && c.endSec > c.startSec ? c.endSec : null,
          title: c.label,
          text: several ? text || block.text : plainText(block.markdown, { citations: false }),
          ...(several ? { context: block.text } : {}),
          source: {
            pageId: page.id,
            pageTitle: page.title,
            pageKind: page.kind,
            headings: block.headings,
          },
          entities: [page.id, ...new Set(linked)].map((id) => entityOf(pageMap.get(id)!)),
          rank: 0,
        });
      }
    }
  }
  return {
    show: { id: show.id, name: show.name, code: show.code },
    sessions: sessionMap,
    pages: pageMap,
    names,
    citations,
  };
}

/** Resolve page titles, aliases or ids to page ids; unknown values are returned separately. */
function resolveEntities(k: Knowledge, values: string[]): { ids: string[]; unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const v of values) {
    const id = k.pages.has(v) ? v : k.names.get(normTitle(v));
    if (id) ids.push(id);
    else unknown.push(v);
  }
  return { ids: [...new Set(ids)], unknown };
}

/** Words of a text or name, lowercased: what entity names are matched on. */
const words = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu) ?? []).map((w) =>
    w.replace(/\u2019/g, "'"),
  );

/**
 * A matcher that finds which pages a free text (topic, event, transcript line) names: whole-word,
 * case-insensitive matches of their titles and aliases (3+ characters), by looking up the text's
 * word n-grams in a map — linear in the text, whatever the number of names.
 */
function nameMatcher(k: Knowledge): (text: string) => MomentEntity[] {
  const byWords = new Map<string, string>();
  let longest = 0;
  for (const [name, id] of k.names) {
    const w = words(name);
    if (name.length < 3 || !w.length) continue;
    const key = w.join(' ');
    if (!byWords.has(key)) byWords.set(key, id);
    longest = Math.max(longest, w.length);
  }
  if (!byWords.size) return () => [];
  return (text) => {
    const w = words(text);
    const found = new Set<string>();
    for (let i = 0; i < w.length; i++) {
      let key = '';
      for (let n = 0; n < longest && i + n < w.length; n++) {
        key = n ? `${key} ${w[i + n]}` : w[i]!;
        const id = byWords.get(key);
        if (id) found.add(id);
      }
    }
    return [...found].map((id) => entityOf(k.pages.get(id)!));
  };
}

/**
 * The query as a tsquery: websearch syntax (all words, "phrases", -not, or), or with `any` every
 * word OR-ed — the fallback when nothing matches all of them.
 */
function tsQuery(query: string, any: boolean) {
  if (!any) return sql`websearch_to_tsquery('english', ${query})`;
  // Letters and digits only, so the joined string is always valid to_tsquery syntax.
  return sql`to_tsquery('english', ${queryWords(query).join(' | ')})`;
}

/** The query's words, letters and digits only. */
const queryWords = (query: string) => query.match(/[\p{L}\p{N}]+/gu) ?? [];

/** Whether `query` has more than one word, so OR-ing them can find more. */
const severalWords = (query: string) => queryWords(query).length > 1;

/** What a moment is ranked on: where it sits (page, headings, topic title) and what it says. */
interface RankDoc {
  head: string;
  body: string;
}

/**
 * ts_rank of each document against the query (0 when it doesn't match), in input order. The head
 * (page title, headings, topic title) weighs most, so an item under "Age" ranks first for "age".
 * With `any` (the relaxed fallback) a document must match at least half of the query's words, and
 * its rank is scaled by the share it matches.
 */
async function rankTexts(ctx: Ctx, query: string, docs: RankDoc[], any = false): Promise<number[]> {
  if (!docs.length) return [];
  const rows = await ctx.db.execute<{ i: string; r: number; hits: number; n: number }>(sql`
    with lx as (select unnest(tsvector_to_array(to_tsvector('english', ${query}))) as l),
         x as (
           select d.i,
                  setweight(to_tsvector('english', d.v->>'head'), 'A') ||
                  setweight(to_tsvector('english', d.v->>'body'), 'D') as v
           from jsonb_array_elements(${JSON.stringify(docs)}::jsonb) with ordinality as d(v, i)
         )
    select x.i, ts_rank(x.v, q) as r,
           (select count(*) from lx where x.v @@ to_tsquery('simple', quote_literal(lx.l)))::int as hits,
           (select count(*) from lx)::int as n
    from x, ${tsQuery(query, any)} as q
    where x.v @@ q`);
  const ranks = new Array<number>(docs.length).fill(0);
  for (const r of rows) {
    const n = Number(r.n);
    const hits = Number(r.hits);
    if (any && n > 1 && hits < Math.ceil(n / 2)) continue;
    ranks[Number(r.i) - 1] = Number(r.r) * (any && n > 0 ? hits / n : 1);
  }
  return ranks;
}

async function topicMoments(ctx: Ctx, k: Knowledge, sessionIds: string[]): Promise<Moment[]> {
  if (!sessionIds.length) return [];
  const rows = await ctx.db.select().from(topics).where(inArray(topics.sessionId, sessionIds));
  return rows.map((t) => {
    const s = k.sessions.get(t.sessionId)!;
    return {
      kind: 'topic' as const,
      id: t.id,
      sessionId: s.id,
      sessionTitle: s.title,
      sessionDate: s.date,
      startSec: t.startSec,
      endSec: t.durationSec > 0 ? t.startSec + t.durationSec : null,
      title: t.title,
      text: t.summary ? `${t.title} — ${t.summary}` : t.title,
      entities: [],
      rank: 0,
    };
  });
}

/**
 * Editorial notes ("Note" events, e.g. "speakers named by hand") are about the recording, not its
 * content: findable by query, but never tagged with entities.
 */
const isNote = (m: Moment) => m.kind === 'event' && m.title.trim().toLowerCase() === 'note';

async function eventMoments(ctx: Ctx, k: Knowledge, sessionIds: string[]): Promise<Moment[]> {
  if (!sessionIds.length) return [];
  const rows = await ctx.db.select().from(events).where(inArray(events.sessionId, sessionIds));
  return rows
    .filter((e) => e.timecodeFrames !== null)
    .map((e) => {
      const s = k.sessions.get(e.sessionId)!;
      return {
        kind: 'event' as const,
        id: e.id,
        sessionId: s.id,
        sessionTitle: s.title,
        sessionDate: s.date,
        // Events logged before the session start are clamped to 0, as search does.
        startSec: Math.max(0, framesToAtSec(e.timecodeFrames!, s)),
        endSec: null,
        title: e.category,
        text: [e.message, e.value].filter(Boolean).join(' — ') || e.category,
        entities: [],
        rank: 0,
      };
    });
}

/** Most transcript lines one search considers (best matches first when there is a query). */
const TRANSCRIPT_CAP = 5000;

/** Transcript lines matching the query (full text) or naming one of `names` — never the whole transcript. */
async function transcriptMoments(
  ctx: Ctx,
  k: Knowledge,
  sessionIds: string[],
  query: string | undefined,
  names: string[],
  any = false,
): Promise<{ moments: Moment[]; capped: boolean }> {
  if (!sessionIds.length || (!query && !names.length)) return { moments: [], capped: false };
  // Names: whole words, any non-word characters between them (the same matching as nameMatcher).
  const namePatterns = names
    .map((n) => words(n))
    .filter((w) => w.length)
    .map((w) => `\\m${w.join('[^[:alnum:]]+')}\\M`);
  if (!query && !namePatterns.length) return { moments: [], capped: false };
  const q = query ? tsQuery(query, any) : null;
  const textMatch = q
    ? sql`${segments.search} @@ ${q}`
    : sql`(${sql.join(
        namePatterns.map((p) => sql`${segments.text} ~* ${p}`),
        sql` or `,
      )})`;
  const rows = await ctx.db
    .select()
    .from(segments)
    .where(and(inArray(segments.sessionId, sessionIds), textMatch))
    .orderBy(
      ...(q ? [sql`ts_rank(${segments.search}, ${q}) desc`] : []),
      asc(segments.sessionId),
      asc(segments.startSec),
    )
    .limit(TRANSCRIPT_CAP);
  const moments = rows.map((t) => {
    const s = k.sessions.get(t.sessionId)!;
    return {
      kind: 'transcript' as const,
      id: t.id,
      sessionId: s.id,
      sessionTitle: s.title,
      sessionDate: s.date,
      startSec: t.startSec,
      endSec: t.endSec,
      title: t.speaker || 'Speaker',
      text: t.text,
      entities: [],
      rank: 0,
    };
  });
  return { moments, capped: rows.length === TRANSCRIPT_CAP };
}

/**
 * Citations of the same range (session, start, end) from several pages — a recap, a bit page and
 * a person page citing one story — become one moment: the best-ranked one, with every entity and
 * the other citing pages in `alsoCitedBy`. Other kinds are kept as they are.
 */
function mergeSameRange(moments: Moment[]): Moment[] {
  const groups = new Map<string, Moment[]>();
  const order: (Moment | string)[] = [];
  for (const m of moments) {
    if (m.kind !== 'citation') {
      order.push(m);
      continue;
    }
    const key = `${m.sessionId}\u0000${m.startSec}\u0000${m.endSec}`;
    const group = groups.get(key);
    if (group) group.push(m);
    else {
      groups.set(key, [m]);
      order.push(key);
    }
  }
  return order.map((item) => {
    if (typeof item !== 'string') return item;
    const group = groups.get(item)!;
    if (group.length === 1) return group[0]!;
    // The best-ranked copy (the first on ties) describes the moment; the rest add entities.
    const best = group.reduce((a, b) => (b.rank > a.rank ? b : a));
    const entities = [...best.entities];
    for (const m of group)
      for (const e of m.entities)
        if (!entities.some((x) => x.pageId === e.pageId)) entities.push(e);
    const alsoCitedBy: { pageId: string; pageTitle: string }[] = [];
    for (const m of group)
      if (
        m.source &&
        m.source.pageId !== best.source?.pageId &&
        !alsoCitedBy.some((c) => c.pageId === m.source!.pageId)
      )
        alsoCitedBy.push({ pageId: m.source.pageId, pageTitle: m.source.pageTitle });
    return { ...best, entities, ...(alsoCitedBy.length ? { alsoCitedBy } : {}) };
  });
}

const KIND_WEIGHT: Record<Moment['kind'], number> = {
  citation: 1.3,
  topic: 1.5,
  event: 1,
  transcript: 1,
};

/**
 * Moments of one session merged into ranges when they overlap or are at most `gap` apart, never
 * past `maxSec`. A moment longer than `maxSec` (a whole-segment topic) is left out when tighter
 * moments overlap it, and otherwise becomes a clip of its own.
 */
function mergeClips(
  moments: Moment[],
  gap: number,
  pointSec: number,
  maxSec: number,
): MomentClip[] {
  const bySession = new Map<string, Moment[]>();
  for (const m of moments) {
    const list = bySession.get(m.sessionId);
    if (list) list.push(m);
    else bySession.set(m.sessionId, [m]);
  }
  type Building = MomentClip & { titles: string[] };
  const clips: Building[] = [];
  const endOf = (m: Moment) => m.endSec ?? m.startSec + pointSec;
  for (const all of bySession.values()) {
    const tight = all.filter((m) => endOf(m) - m.startSec <= maxSec);
    const broad = all.filter(
      (m) =>
        endOf(m) - m.startSec > maxSec &&
        !tight.some((t) => t.startSec < endOf(m) && endOf(t) > m.startSec),
    );
    const list = [...tight, ...broad].sort((a, b) => a.startSec - b.startSec);
    let cur: Building | null = null;
    for (const m of list) {
      const end = endOf(m);
      if (
        cur &&
        m.startSec <= cur.endSec + gap &&
        Math.max(cur.endSec, end) - cur.startSec <= maxSec
      ) {
        cur.endSec = Math.max(cur.endSec, end);
        cur.momentIds.push(m.id);
        cur.titles.push(m.title);
        for (const e of m.entities)
          if (!cur.entities.some((x) => x.pageId === e.pageId)) cur.entities.push(e);
        continue;
      }
      if (cur) clips.push(cur);
      cur = {
        sessionId: m.sessionId,
        sessionTitle: m.sessionTitle,
        startSec: m.startSec,
        endSec: end,
        label: '',
        momentIds: [m.id],
        entities: [...m.entities],
        titles: [m.title || m.text.slice(0, 60)],
      };
    }
    if (cur) clips.push(cur);
  }
  // Keep every clip within compilations' limits: at least MIN_CLIP_SEC, longer ones split.
  return clips.flatMap(({ titles, ...c }) => {
    const label = titles.length > 1 ? `${titles[0]} (+${titles.length - 1})` : (titles[0] ?? '');
    const end = Math.max(c.endSec, c.startSec + MIN_CLIP_SEC);
    const parts: MomentClip[] = [];
    for (let from = c.startSec, i = 1; from < end; from += MAX_CLIP_SEC, i++)
      parts.push({
        ...c,
        startSec: from,
        endSec: Math.min(end, from + MAX_CLIP_SEC),
        label: end - c.startSec > MAX_CLIP_SEC ? `${label} (part ${i})` : label,
      });
    return parts;
  });
}

/** Longest moment text in compact results. */
const COMPACT_TEXT = 160;

function compactMoment(m: Moment): CompactMoment {
  const text = m.text.length > COMPACT_TEXT ? `${m.text.slice(0, COMPACT_TEXT - 1)}…` : m.text;
  return {
    kind: m.kind,
    id: m.id,
    sessionId: m.sessionId,
    sessionTitle: m.sessionTitle,
    startSec: m.startSec,
    endSec: m.endSec,
    title: m.title,
    text,
    ...(m.source ? { page: m.source.pageTitle } : {}),
    entities: m.entities.map((e) => e.title),
  };
}

defineOp({
  name: 'moments.search',
  description:
    'Find clip-ready moments of a show: time ranges in sessions, each with what happens there and the wiki pages (people, recurring bits, topics) it is about. Sources, by `kinds` (default all): "citation" — every citation on the show wiki, described by the sentence or list item that cites it and tagged with its page plus the [[pages]] linked in that block (in a table row: its own cell and the cells before it) (the richest source once a wiki exists); "topic" — chapters; "event" — logged events (no end: endSec null; "Note" events are editorial and never tagged with entities); "transcript" — transcript lines (only those matching query or naming an entity). Filter with `query` (full text, websearch syntax: words, "phrases", -exclude, or; page titles and headings weigh most; when nothing matches every word, moments matching at least half the words are returned, ranked by how many, with relaxedQuery: true), `entities` (page titles, aliases or ids — a moment must be about all of them; for topics, events and transcript lines that means naming each entity\'s title or an alias in its text) or both, and `sessionId`. With a query, best matches first; without, in episode order (episode numbers when every session has one, else dates) then time. Every moment has sessionId, startSec and endSec (seconds from the session start; archived sessions included) — cite them, as [label](/sessions/<sessionId>?t=<startSec>&to=<endSec>), or use them as compilation clips. `mergeGapSec` > 0 also returns `clips`: this page\'s moments merged per session where they overlap or are at most that many seconds apart (moments without an end count as `pointSec` long), at most `maxClipSec` long (default 180; a moment longer than that, like a whole-segment topic, is left out where tighter moments cover it) and at least 1 s — pass them to compilations_create as they are; `clipsOnly: true` returns just the clips. Agents get compact results by default (text trimmed to 160 characters, entities and page as titles, clips with a moment count); pass `compact: false` for full moments (context, headings, entity ids). transcriptCapped: true means more transcript lines matched than one search considers (5000, best first): narrow it. Use graph_entity first to see an entity\'s aliases, related pages and the sessions it appears in. Paged: total, limit (default 30, max 500), offset / nextOffset.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, input) {
    const k = await loadKnowledge(ctx, input.showId);
    if (input.sessionId && !k.sessions.has(input.sessionId))
      throw notFound('No such session in this show.');
    const { ids: entityIds, unknown } = resolveEntities(k, input.entities ?? []);
    const empty = {
      total: 0,
      moments: [],
      nextOffset: null,
      ...(input.mergeGapSec > 0 ? { clips: [] } : {}),
      ...(unknown.length ? { unknownEntities: unknown } : {}),
    };
    if (input.entities?.length && !entityIds.length) return empty;
    const kinds = new Set(input.kinds ?? ['citation', 'topic', 'event', 'transcript']);
    const sessionIds = input.sessionId ? [input.sessionId] : [...k.sessions.keys()];
    const matchNames = nameMatcher(k);
    // For free-text sources, an entity is named by its title or any alias.
    const entityNames = entityIds.flatMap((id) => {
      const p = k.pages.get(id)!;
      return [p.title, ...p.aliases].filter((n) => n.trim().length >= 3);
    });

    let transcriptCapped = false;
    const collect = async (any: boolean): Promise<Moment[]> => {
      let found: Moment[] = [];
      if (kinds.has('citation'))
        found.push(
          ...k.citations.filter((m) => !input.sessionId || m.sessionId === input.sessionId),
        );
      const free: Moment[] = [];
      if (kinds.has('topic')) free.push(...(await topicMoments(ctx, k, sessionIds)));
      if (kinds.has('event')) free.push(...(await eventMoments(ctx, k, sessionIds)));
      if (kinds.has('transcript')) {
        const lines = await transcriptMoments(
          ctx,
          k,
          sessionIds,
          input.query,
          input.query ? [] : entityNames,
          any,
        );
        free.push(...lines.moments);
        transcriptCapped = lines.capped;
      }
      for (const m of free) m.entities = isNote(m) ? [] : matchNames(m.text);
      found.push(...free);
      if (entityIds.length)
        found = found.filter((m) =>
          entityIds.every((id) => m.entities.some((e) => e.pageId === id)),
        );
      if (!input.query) return found;
      const ranks = await rankTexts(
        ctx,
        input.query,
        found.map((m) => ({
          head: [m.source?.pageTitle, ...(m.source?.headings ?? []), m.kind === 'topic' && m.title]
            .filter(Boolean)
            .join(' \n '),
          body: m.kind === 'topic' ? m.text : `${m.title} \n ${m.text}`,
        })),
        any,
      );
      return found
        .map((m, i) => ({ ...m, rank: ranks[i]! * KIND_WEIGHT[m.kind] }))
        .filter((m) => m.rank > 0);
    };
    let candidates = await collect(false);
    // Natural phrases rarely match on every word: then take moments matching any of them.
    const relaxed = Boolean(input.query && !candidates.length && severalWords(input.query));
    if (relaxed) candidates = await collect(true);
    candidates = mergeSameRange(candidates);
    const order = (m: Moment) => k.sessions.get(m.sessionId)!.order;
    candidates.sort(
      (a, b) =>
        b.rank - a.rank ||
        order(a) - order(b) ||
        a.startSec - b.startSec ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id),
    );
    const page = candidates.slice(input.offset, input.offset + input.limit);
    const next = input.offset + page.length;
    const clips =
      input.mergeGapSec > 0
        ? mergeClips(page, input.mergeGapSec, input.pointSec, input.maxClipSec)
        : undefined;
    const moments = input.clipsOnly && clips ? [] : page;
    const flags = {
      ...(relaxed ? { relaxedQuery: true } : {}),
      ...(transcriptCapped ? { transcriptCapped: true } : {}),
      ...(unknown.length ? { unknownEntities: unknown } : {}),
    };
    const nextOffset = next < candidates.length ? next : null;
    if (input.compact)
      return {
        total: candidates.length,
        moments: moments.map(compactMoment),
        nextOffset,
        ...(clips
          ? {
              clips: clips.map(({ momentIds, entities: _, ...c }) => ({
                ...c,
                moments: momentIds.length,
              })),
            }
          : {}),
        ...flags,
      };
    return {
      total: candidates.length,
      moments,
      nextOffset,
      ...(clips ? { clips } : {}),
      ...flags,
    };
  },
});

defineOp({
  name: 'graph.entity',
  description:
    'One wiki page of a show seen as a knowledge-graph entity (a person, recurring bit, topic, session recap or question): its kind, aliases and summary, how many moments are about it, the sessions it appears in (episode order, with a count and its first moment each), and related pages — pages it links to, pages linking to it, and pages co-cited with it in the same wiki blocks — strongest first. `entity` is a page title, alias or page id. Use it to orient before moments_search (which takes the same entity names), e.g. "who is X, where do they appear, who do they come up with". Moments come from wiki citations, so an entity with no citing pages has momentCount 0.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, input): Promise<GraphEntity> {
    const k = await loadKnowledge(ctx, input.showId);
    const {
      ids: [pageId],
    } = resolveEntities(k, [input.entity]);
    if (!pageId) throw notFound(`No wiki page titled or aliased "${input.entity}" in this show.`);
    const page = k.pages.get(pageId)!;
    const about = mergeSameRange(
      k.citations.filter((m) => m.entities.some((e) => e.pageId === pageId)),
    );

    const perSession = new Map<string, Moment[]>();
    for (const m of about) {
      const list = perSession.get(m.sessionId);
      if (list) list.push(m);
      else perSession.set(m.sessionId, [m]);
    }
    const sessionList = [...perSession.entries()]
      .map(([sid, list]) => {
        const s = k.sessions.get(sid)!;
        const first = [...list].sort((a, b) => a.startSec - b.startSec)[0]!;
        return {
          sessionId: sid,
          sessionTitle: s.title,
          sessionDate: s.date,
          moments: list.length,
          first: { startSec: first.startSec, endSec: first.endSec, text: first.text },
          order: s.order,
        };
      })
      .sort((a, b) => a.order - b.order)
      .map(({ order: _, ...rest }) => rest);

    const related = new Map<
      string,
      { weight: number; via: Set<'links' | 'linkedFrom' | 'coCited'> }
    >();
    const bump = (id: string, w: number, via: 'links' | 'linkedFrom' | 'coCited') => {
      if (id === pageId) return;
      const r = related.get(id) ?? { weight: 0, via: new Set() };
      r.weight += w;
      r.via.add(via);
      related.set(id, r);
    };
    const linksOf = (p: PageInfo) =>
      new Set(
        wikiSections(p.bodyMd, p.sessionId)
          .flatMap((s) => s.links)
          .map((t) => k.names.get(normTitle(t)))
          .filter((id): id is string => Boolean(id)),
      );
    for (const id of linksOf(page)) bump(id, 3, 'links');
    for (const other of k.pages.values())
      if (other.id !== pageId && linksOf(other).has(pageId)) bump(other.id, 2, 'linkedFrom');
    for (const m of about) for (const e of m.entities) bump(e.pageId, 1, 'coCited');

    return {
      pageId,
      showId: k.show.id,
      title: page.title,
      kind: page.kind,
      aliases: page.aliases,
      summary: firstParagraph(page.bodyMd),
      sessionId: page.sessionId,
      momentCount: about.length,
      sessions: sessionList,
      related: [...related.entries()]
        .map(([id, r]) => ({ ...entityOf(k.pages.get(id)!), weight: r.weight, via: [...r.via] }))
        .sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title))
        .slice(0, input.relatedLimit),
    };
  },
});

// ── export ──────────────────────────────────────────────────

const NODE_LABEL: Record<WikiKind, string> = {
  person: 'Person',
  topic: 'Topic',
  bit: 'Bit',
  session: 'Recap',
  question: 'Question',
};

/** Property-graph rows: nodes, edges, moments (citations, topics, events) and wiki chunks. */
async function graphRows(ctx: Ctx, k: Knowledge) {
  const nodes: Record<string, unknown>[] = [
    { type: 'node', id: k.show.id, label: 'Show', name: k.show.name, code: k.show.code },
  ];
  for (const s of [...k.sessions.values()].sort((a, b) => a.order - b.order))
    nodes.push({
      type: 'node',
      id: s.id,
      label: 'Episode',
      name: s.title,
      episode: s.episode || null,
      date: s.date,
      order: s.order + 1,
    });
  for (const p of k.pages.values())
    nodes.push({
      type: 'node',
      id: p.id,
      label: NODE_LABEL[p.kind],
      name: p.title,
      aliases: p.aliases,
      summary: firstParagraph(p.bodyMd),
      sessionId: p.sessionId,
      revision: p.revision,
      updatedAt: p.updatedAt,
    });

  const edges: Record<string, unknown>[] = [];
  for (const s of k.sessions.values())
    edges.push({ type: 'edge', label: 'PART_OF', from: s.id, to: k.show.id });
  for (const p of k.pages.values()) {
    if (p.sessionId && k.sessions.has(p.sessionId))
      edges.push({ type: 'edge', label: 'RECAP_OF', from: p.id, to: p.sessionId });
    const targets = new Set(
      wikiSections(p.bodyMd, p.sessionId)
        .flatMap((s) => s.links)
        .map((t) => k.names.get(normTitle(t)))
        .filter((id): id is string => Boolean(id) && id !== p.id),
    );
    for (const to of targets) edges.push({ type: 'edge', label: 'LINKS_TO', from: p.id, to });
  }
  const appears = new Map<string, number>();
  for (const m of k.citations)
    for (const e of m.entities) {
      if (k.pages.get(e.pageId)?.kind === 'session') continue;
      const key = `${e.pageId}\u0000${m.sessionId}`;
      appears.set(key, (appears.get(key) ?? 0) + 1);
    }
  for (const [key, moments] of appears) {
    const [from, to] = key.split('\u0000');
    edges.push({ type: 'edge', label: 'APPEARS_IN', from, to, moments });
  }

  const sessionIds = [...k.sessions.keys()];
  const matchNames = nameMatcher(k);
  const free = [
    ...(await topicMoments(ctx, k, sessionIds)),
    ...(await eventMoments(ctx, k, sessionIds)),
  ];
  for (const m of free) m.entities = isNote(m) ? [] : matchNames(m.text);
  const order = (m: Moment) => k.sessions.get(m.sessionId)!.order;
  const moments = [...k.citations, ...free]
    .sort((a, b) => order(a) - order(b) || a.startSec - b.startSec || a.id.localeCompare(b.id))
    .map(({ rank: _, ...m }) => ({ type: 'moment', ...m }));

  const chunks: Record<string, unknown>[] = [];
  for (const p of k.pages.values())
    for (const s of wikiSections(p.bodyMd, p.sessionId)) {
      const path = [k.show.name, p.title, ...s.headings];
      chunks.push({
        type: 'chunk',
        id: `${p.id}#s${s.ord}`,
        pageId: p.id,
        pageTitle: p.title,
        pageKind: p.kind,
        headings: s.headings,
        /** Prefix for embedding so the chunk says what it is about on its own. */
        context: path.join(' › '),
        text: s.text,
        markdown: s.markdown,
        citations: s.citations
          .filter((c) => k.sessions.has(c.sessionId))
          .map((c) => ({
            sessionId: c.sessionId,
            sessionTitle: k.sessions.get(c.sessionId)!.title,
            startSec: c.startSec,
            endSec: c.endSec ?? null,
            label: c.label,
          })),
        entities: [
          ...new Set(
            s.links.map((t) => k.names.get(normTitle(t))).filter((id): id is string => Boolean(id)),
          ),
        ].map((id) => entityOf(k.pages.get(id)!)),
      });
    }
  return { nodes, edges, moments, chunks };
}

const AL = 'https://autologger.app/ns#';

/** One schema.org JSON-LD document; `al:` terms cover what schema.org has no word for. */
function jsonLd(k: Knowledge, rows: Awaited<ReturnType<typeof graphRows>>) {
  // Instances are IRIs on this server (relative to @base); `al:` is only for vocabulary terms.
  const iri = (id: string) =>
    id.startsWith('ses_')
      ? `sessions/${id}`
      : id.startsWith('wiki_')
        ? `wiki/${id}`
        : `shows/${encodeURIComponent(id)}`;
  const ref = (id: string) => ({ '@id': iri(id) });
  const graph: Record<string, unknown>[] = [
    {
      '@id': iri(k.show.id),
      '@type': 'PodcastSeries',
      name: k.show.name,
      'al:code': k.show.code,
    },
  ];
  for (const s of [...k.sessions.values()].sort((a, b) => a.order - b.order))
    graph.push({
      '@id': iri(s.id),
      '@type': 'PodcastEpisode',
      name: s.title,
      ...(s.episode ? { episodeNumber: s.episode } : {}),
      ...(s.episodeDate ? { datePublished: s.episodeDate } : {}),
      position: s.order + 1,
      partOfSeries: ref(k.show.id),
    });
  const type: Record<WikiKind, string | string[]> = {
    person: 'Person',
    topic: ['DefinedTerm', 'al:Topic'],
    bit: ['CreativeWork', 'al:Bit'],
    session: ['Article', 'al:Recap'],
    question: 'Question',
  };
  const linksFrom = new Map<string, string[]>();
  for (const e of rows.edges)
    if (e.label === 'LINKS_TO')
      linksFrom.set(e.from as string, [...(linksFrom.get(e.from as string) ?? []), e.to as string]);
  for (const p of k.pages.values())
    graph.push({
      '@id': iri(p.id),
      '@type': type[p.kind],
      name: p.title,
      ...(p.aliases.length ? { alternateName: p.aliases } : {}),
      description: firstParagraph(p.bodyMd),
      dateModified: p.updatedAt,
      ...(p.sessionId ? { about: ref(p.sessionId) } : {}),
      ...(linksFrom.get(p.id)?.length ? { mentions: linksFrom.get(p.id)!.map(ref) } : {}),
      isPartOf: ref(k.show.id),
    });
  for (const m of rows.moments)
    graph.push({
      '@id': `moments/${encodeURIComponent(m.id)}`,
      '@type': [
        'Clip',
        `al:${m.kind === 'citation' ? 'Citation' : m.kind === 'topic' ? 'Chapter' : 'LoggedEvent'}`,
      ],
      name: m.title,
      description: m.text,
      isPartOf: ref(m.sessionId),
      startOffset: m.startSec,
      ...(m.endSec !== null ? { endOffset: m.endSec } : {}),
      ...(m.entities.length ? { about: m.entities.map((e) => ref(e.pageId)) } : {}),
      ...(m.source ? { 'al:citedBy': ref(m.source.pageId), 'al:section': m.source.headings } : {}),
    });
  return {
    '@context': [
      'https://schema.org/',
      {
        '@base': `${env.publicUrl}/`,
        al: AL,
        startOffset: { '@type': 'xsd:decimal' },
        endOffset: { '@type': 'xsd:decimal' },
      },
    ],
    '@graph': graph,
  };
}

defineOp({
  name: 'graph.export',
  description:
    'Export a show\'s knowledge graph, built live from its sessions, wiki pages ([[links]], aliases, citations), topics and events. format "jsonl" (default) returns property-graph rows, paged with limit/offset: `section` "nodes" (show, episodes, wiki pages with summaries), "edges" (PART_OF, RECAP_OF, LINKS_TO, APPEARS_IN with a moment count), "moments" (citations, topics and events as clip ranges tagged with entities — what moments_search searches) or "chunks" (each wiki section with its heading path, plain text, citations and entities: ready for a vector index), or "all" (in that order). format "jsonld" returns one schema.org JSON-LD document (PodcastSeries, PodcastEpisode, Person, Clip with startOffset/endOffset and about) — large: prefer the file download GET /api/shows/<showId>/export/graph.jsonld (also graph.jsonl, moments.jsonl, chunks.jsonl) with the same bearer token. To query rather than copy the graph, use moments_search and graph_entity.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, input) {
    const k = await loadKnowledge(ctx, input.showId);
    const rows = await graphRows(ctx, k);
    if (input.format === 'jsonld') return { format: 'jsonld' as const, document: jsonLd(k, rows) };
    const all =
      input.section === 'all'
        ? [...rows.nodes, ...rows.edges, ...rows.moments, ...rows.chunks]
        : rows[input.section];
    const page = all.slice(input.offset, input.offset + input.limit);
    const next = input.offset + page.length;
    return {
      format: 'jsonl' as const,
      section: input.section,
      total: all.length,
      nextOffset: next < all.length ? next : null,
      rows: page,
    };
  },
});
