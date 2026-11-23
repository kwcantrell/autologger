// The show knowledge graph: a read-only projection of what AutoLogger already stores — sessions,
// wiki pages with their [[links]], aliases and citations, topics and events — into entities,
// relations and "moments" (clip-ready session ranges tagged with the entities they are about).
// Nothing here is stored: every call reads the current data, so it never drifts from the wiki.

import {
  framesToAtSec,
  type GraphEntity,
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
import { firstParagraph } from './wiki.ts';

const { wikiPages: pages, sessions, topics, events, transcriptSegments: segments } = schema;

interface SessionInfo {
  id: string;
  title: string;
  episode: string;
  episodeDate: string | null;
  /** Episode date, or the creation instant — the same "sessionDate" search returns. */
  date: string;
  /** Position in episode order (date, then title). */
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
  withDate.sort(
    (a, b) =>
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
      const several = block.claims.length > 1;
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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A matcher that finds which pages a free text (topic, event, transcript line) names, by whole-word,
 * case-insensitive match of their titles and aliases (3+ characters).
 */
function nameMatcher(k: Knowledge): (text: string) => MomentEntity[] {
  const entries = [...k.names.entries()].filter(([n]) => n.length >= 3);
  if (!entries.length) return () => [];
  entries.sort((a, b) => b[0].length - a[0].length);
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])(${entries.map(([n]) => escapeRe(n).replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`,
    'giu',
  );
  return (text) => {
    const found = new Set<string>();
    for (const m of text.matchAll(re)) {
      const id = k.names.get(normTitle(m[1]!));
      if (id) found.add(id);
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
  const words = query.match(/[\p{L}\p{N}']+/gu) ?? [];
  return sql`to_tsquery('english', ${
    words
      .map((w) => w.replace(/'/g, ''))
      .filter(Boolean)
      .join(' | ') || "''"
  })`;
}

/** Whether `query` has more than one word, so OR-ing them can find more. */
const severalWords = (query: string) => (query.match(/[\p{L}\p{N}']+/gu) ?? []).length > 1;

/** ts_rank of each text against the query (0 when it doesn't match), in input order. */
async function rankTexts(ctx: Ctx, query: string, texts: string[], any = false): Promise<number[]> {
  if (!texts.length) return [];
  const rows = await ctx.db.execute<{ i: string; r: number }>(sql`
    select x.i, ts_rank(to_tsvector('english', x.t), q) as r
    from jsonb_array_elements_text(${JSON.stringify(texts)}::jsonb) with ordinality as x(t, i),
         ${tsQuery(query, any)} as q
    where to_tsvector('english', x.t) @@ q`);
  const ranks = new Array<number>(texts.length).fill(0);
  for (const r of rows) ranks[Number(r.i) - 1] = Number(r.r);
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
        startSec: framesToAtSec(e.timecodeFrames!, s),
        endSec: null,
        title: e.category,
        text: [e.message, e.value].filter(Boolean).join(' — ') || e.category,
        entities: [],
        rank: 0,
      };
    });
}

/** Transcript lines matching the query (full text) or naming one of `names` — never the whole transcript. */
async function transcriptMoments(
  ctx: Ctx,
  k: Knowledge,
  sessionIds: string[],
  query: string | undefined,
  names: string[],
  any = false,
): Promise<Moment[]> {
  if (!sessionIds.length || (!query && !names.length)) return [];
  const textMatch = query
    ? sql`${segments.search} @@ ${tsQuery(query, any)}`
    : sql`(${sql.join(
        names.map((n) => sql`${segments.text} ilike ${`%${n.replace(/[\\%_]/g, '\\$&')}%`}`),
        sql` or `,
      )})`;
  const rows = await ctx.db
    .select()
    .from(segments)
    .where(and(inArray(segments.sessionId, sessionIds), textMatch))
    .limit(5000);
  return rows.map((t) => {
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
}

const KIND_WEIGHT: Record<Moment['kind'], number> = {
  citation: 1.3,
  topic: 1.5,
  event: 1,
  transcript: 1,
};

/** Moments of one session merged into ranges when they overlap or are at most `gap` apart. */
function mergeClips(moments: Moment[], gap: number, pointSec: number): MomentClip[] {
  const bySession = new Map<string, Moment[]>();
  for (const m of moments) bySession.set(m.sessionId, [...(bySession.get(m.sessionId) ?? []), m]);
  type Building = MomentClip & { titles: string[] };
  const clips: Building[] = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.startSec - b.startSec);
    let cur: Building | null = null;
    for (const m of list) {
      const end = m.endSec ?? m.startSec + pointSec;
      if (cur && m.startSec <= cur.endSec + gap) {
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
  return clips.map(({ titles, ...c }) => ({
    ...c,
    label: titles.length > 1 ? `${titles[0]} (+${titles.length - 1})` : (titles[0] ?? ''),
  }));
}

defineOp({
  name: 'moments.search',
  description:
    'Find clip-ready moments of a show: time ranges in sessions, each with what happens there and the wiki pages (people, recurring bits, topics) it is about. Sources, by `kinds` (default all): "citation" — every citation on the show wiki, described by the sentence or list item that cites it and tagged with its page plus the [[pages]] linked in that block (the richest source once a wiki exists); "topic" — chapters; "event" — logged events (no end: endSec null); "transcript" — transcript lines (only those matching query or naming an entity). Filter with `query` (full text, websearch syntax: words, "phrases", -exclude, or; when nothing matches every word, moments matching any word are returned with relaxedQuery: true), `entities` (page titles, aliases or ids — a moment must be about all of them; for topics, events and transcript lines that means naming each entity\'s title or an alias in its text) or both, and `sessionId`. With a query, best matches first; without, in episode order then time. Every moment has sessionId, startSec and endSec (seconds from the session start) — pass them as clips to compilations_create, or cite them as [label](/sessions/<sessionId>?t=<startSec>&to=<endSec>). `mergeGapSec` > 0 also returns `clips`: this page\'s moments merged per session where they overlap or are at most that many seconds apart (moments without an end count as `pointSec` long). Use graph_entity first to see an entity\'s aliases, related pages and the sessions it appears in. Paged: total, limit (default 30, max 500), offset / nextOffset.',
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

    const collect = async (any: boolean): Promise<Moment[]> => {
      let found: Moment[] = [];
      if (kinds.has('citation'))
        found.push(
          ...k.citations.filter((m) => !input.sessionId || m.sessionId === input.sessionId),
        );
      const free: Moment[] = [];
      if (kinds.has('topic')) free.push(...(await topicMoments(ctx, k, sessionIds)));
      if (kinds.has('event')) free.push(...(await eventMoments(ctx, k, sessionIds)));
      if (kinds.has('transcript'))
        free.push(
          ...(await transcriptMoments(
            ctx,
            k,
            sessionIds,
            input.query,
            input.query ? [] : entityNames,
            any,
          )),
        );
      for (const m of free) m.entities = matchNames(m.text);
      found.push(...free);
      if (entityIds.length)
        found = found.filter((m) =>
          entityIds.every((id) => m.entities.some((e) => e.pageId === id)),
        );
      if (!input.query) return found;
      const ranks = await rankTexts(
        ctx,
        input.query,
        found.map((m) =>
          [m.source?.pageTitle, ...(m.source?.headings ?? []), m.title, m.text]
            .filter(Boolean)
            .join(' \n '),
        ),
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
    return {
      total: candidates.length,
      moments: page,
      nextOffset: next < candidates.length ? next : null,
      ...(input.mergeGapSec > 0
        ? { clips: mergeClips(page, input.mergeGapSec, input.pointSec) }
        : {}),
      ...(relaxed ? { relaxedQuery: true } : {}),
      ...(unknown.length ? { unknownEntities: unknown } : {}),
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
    const about = k.citations.filter((m) => m.entities.some((e) => e.pageId === pageId));

    const perSession = new Map<string, Moment[]>();
    for (const m of about) perSession.set(m.sessionId, [...(perSession.get(m.sessionId) ?? []), m]);
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
  for (const m of free) m.entities = matchNames(m.text);
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
  const ref = (id: string) => ({ '@id': `al:${id}` });
  const graph: Record<string, unknown>[] = [
    {
      '@id': `al:${k.show.id}`,
      '@type': 'PodcastSeries',
      name: k.show.name,
      'al:code': k.show.code,
    },
  ];
  for (const s of [...k.sessions.values()].sort((a, b) => a.order - b.order))
    graph.push({
      '@id': `al:${s.id}`,
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
      '@id': `al:${p.id}`,
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
      '@id': `al:moment/${m.id}`,
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
      { al: AL, startOffset: { '@type': 'xsd:decimal' }, endOffset: { '@type': 'xsd:decimal' } },
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
