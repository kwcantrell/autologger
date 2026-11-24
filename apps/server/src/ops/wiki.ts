import {
  normTitle,
  setCitationEnds,
  setCitationLabels,
  unresolvedShortCitations,
  type WikiCitation,
  type WikiCitationProblem,
  type WikiLint,
  type WikiList,
  type WikiListItem,
  type WikiPage,
  type WikiPageSummary,
  type WikiSavedCitations,
  wikiCitations,
  wikiLinkTargets,
} from '@autologger/contract';
import { and, asc, desc, eq, inArray, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import {
  readableShowCondition,
  requireSession,
  requireShow,
  requireTeamRole,
} from '../core/authz.ts';
import { badRequest, conflict, notFound } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp, snapshot } from '../core/op.ts';
import { type Db, schema } from '../db/client.ts';
import {
  deleteObject,
  getObjectBytes,
  headObject,
  presignUpload,
  requireStorage,
  UPLOAD_URL_TTL_SEC,
  wikiUploadKeyFor,
} from '../media/s3.ts';
import { iso, userRefs } from './map.ts';

const {
  wikiPages: pages,
  wikiRevisions: revisions,
  wikiLinks: links,
  wikiCitations: citations,
  sessions,
  shows,
} = schema;
type PageRow = typeof pages.$inferSelect;

/** Deleted pages are kept (with their revisions) for undo, but are invisible everywhere else. */
const live = isNull(pages.deletedAt);

export { normTitle };

/**
 * Which wiki a page lives in: a show's (showId set; teamId is the show's team) or the team's shared
 * wiki (showId null). A show page's [[links]] resolve to its show's pages first, then the team's;
 * a team page's to team pages, then to pages of the team's shows for names only one show uses.
 */
export interface Layer {
  showId: string | null;
  teamId: string;
}

const sameLayer = (a: Layer, b: Layer) => a.showId === b.showId && a.teamId === b.teamId;

/** Live pages of exactly this layer (a show's own pages, or the team's). */
const inLayer = (layer: Layer) =>
  layer.showId
    ? eq(pages.showId, layer.showId)
    : and(isNull(pages.showId), eq(pages.teamId, layer.teamId));

/** The layer of a stored page. */
async function layerOf(db: Ctx['db'], row: Pick<PageRow, 'showId' | 'teamId'>): Promise<Layer> {
  if (row.teamId) return { showId: null, teamId: row.teamId };
  const [show] = await db
    .select({ teamId: shows.teamId })
    .from(shows)
    .where(eq(shows.id, row.showId!));
  if (!show) throw notFound('Show');
  return { showId: row.showId, teamId: show.teamId };
}

/**
 * Check access to a wiki given as { showId } or { teamId } and return its layer. A show wiki
 * needs show access; the team wiki is read and written by every team member.
 */
async function requireLayer(
  ctx: Ctx,
  scope: { showId?: string | null; teamId?: string | null },
  need: 'read' | 'write',
): Promise<Layer> {
  if (scope.showId) {
    const { show } = await requireShow(ctx, scope.showId, need);
    return { showId: show.id, teamId: show.teamId };
  }
  if (!scope.teamId) throw badRequest('Give showId or teamId.');
  await requireTeamRole(ctx, scope.teamId, 'member');
  return { showId: null, teamId: scope.teamId };
}

/** Normalised title or alias → page id over the given pages (titles win over aliases). */
function namesOf(rows: { id: string; title: string; aliases: string[] }[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const r of rows) byName.set(normTitle(r.title), r.id);
  for (const r of rows)
    for (const a of r.aliases) if (!byName.has(normTitle(a))) byName.set(normTitle(a), r.id);
  return byName;
}

async function summaries(ctx: Ctx, rows: PageRow[]): Promise<WikiPageSummary[]> {
  const users = await userRefs(
    ctx.db,
    rows.map((r) => r.updatedBy),
  );
  return rows.map((r) => ({
    id: r.id,
    showId: r.showId,
    teamId: r.teamId,
    kind: r.kind,
    title: r.title,
    aliases: r.aliases,
    sessionId: r.sessionId,
    revision: r.revision,
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: r.updatedBy ? (users.get(r.updatedBy) ?? null) : null,
  }));
}

/**
 * Every title and alias a [[link]] on a page of this layer can name (normalised like the web's
 * link resolver) → the page id it resolves to. In a show: the show's pages, then the team's for
 * names the show doesn't use. On a team page: the team's pages, then pages of the team's shows for
 * names exactly one show uses (a show hub, a recap, a bit), so the team wiki can link down; a name
 * two shows use is ambiguous and stays unresolved. Titles win over aliases within each wiki. With
 * `own`, only the layer's own pages (for title lookups and clashes).
 */
export async function wikiNames(
  db: Ctx['db'],
  layer: Layer,
  own = false,
): Promise<Map<string, string>> {
  const teamLayer: Layer = { showId: null, teamId: layer.teamId };
  const select = (l: Layer) =>
    db
      .select({ id: pages.id, title: pages.title, aliases: pages.aliases })
      .from(pages)
      .where(and(live, inLayer(l)));
  const mine = namesOf(await select(layer));
  if (own) return mine;
  if (!layer.showId) return new Map([...(await teamShowNames(db, layer.teamId)), ...mine]);
  return new Map([...namesOf(await select(teamLayer)), ...mine]);
}

/**
 * The names of the team's show pages that a team page's [[links]] reach: per show its titles and
 * aliases (titles first), keeping only names that resolve in exactly one show.
 */
export async function teamShowNames(db: Ctx['db'], teamId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: pages.id, showId: pages.showId, title: pages.title, aliases: pages.aliases })
    .from(pages)
    .innerJoin(shows, eq(shows.id, pages.showId))
    .where(and(live, eq(shows.teamId, teamId)));
  const byShow = new Map<string, typeof rows>();
  for (const r of rows) byShow.set(r.showId!, [...(byShow.get(r.showId!) ?? []), r]);
  const found = new Map<string, string | null>();
  for (const list of byShow.values())
    for (const [n, id] of namesOf(list)) found.set(n, found.has(n) ? null : id);
  return new Map([...found].filter((e): e is [string, string] => e[1] !== null));
}

/**
 * Re-index a page's [[links]] and session citations from its body. Every write of `bodyMd` calls
 * this (upsert, patch, restore, undo); a soft delete keeps the rows, which readers skip by joining
 * live pages. `sessionId` is the page's own session, which short citations (`[label](@1664-1760)`)
 * resolve to.
 */
export async function indexWikiLinks(
  db: Ctx['db'],
  pageId: string,
  bodyMd: string,
  sessionId?: string | null,
) {
  await db.delete(links).where(eq(links.fromPageId, pageId));
  const targets = wikiLinkTargets(bodyMd);
  if (targets.length)
    await db.insert(links).values(
      targets.map((target, i) => ({
        fromPageId: pageId,
        targetNorm: normTitle(target),
        target,
        ord: i + 1,
      })),
    );
  await db.delete(citations).where(eq(citations.fromPageId, pageId));
  const cites = wikiCitations(bodyMd, sessionId);
  if (cites.length)
    await db.insert(citations).values(
      cites.map((c, i) => ({
        fromPageId: pageId,
        ord: i + 1,
        sessionId: c.sessionId,
        startSec: c.startSec,
        endSec: c.endSec ?? null,
        label: c.label,
      })),
    );
}

/** Reject short citations without a session (`[label](@1664-1760)`) on a page that has none. */
function checkShortCitations(bodyMd: string, sessionId: string | null) {
  const bad = unresolvedShortCitations(bodyMd, sessionId);
  if (bad.length)
    throw badRequest(
      `${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ` and ${bad.length - 3} more` : ''}: short citations without a session id only work on a page with a sessionId; write [label](@<sessionId>:<startSec>-<endSec>) here.`,
    );
}

/**
 * Index the links and citations of pages written before those indexes existed: pages (live or
 * deleted) whose body contains `[[` but that have no wiki_links rows, or contains `/sessions/` but
 * have no wiki_citations rows. Runs at API startup; idempotent, and one query when nothing is
 * pending. Uses the shared JS parsers so the index matches what the ops write (a SQL regex port
 * would differ on Unicode whitespace and case). Pages whose markers yield nothing (e.g. only
 * inside code) stay without rows and are re-read on each run, which is harmless.
 * Returns how many pages got rows.
 */
export async function backfillWikiLinks(db: Db, batchSize = 200): Promise<number> {
  let after = '';
  let indexed = 0;
  for (;;) {
    const batch = await db.transaction(async (tx) => {
      // Re-checked inside the transaction (and locked), so a page an op indexes meanwhile is skipped.
      const rows = await tx
        .select({ id: pages.id, bodyMd: pages.bodyMd, sessionId: pages.sessionId })
        .from(pages)
        .where(
          and(
            sql`${pages.id} > ${after}`,
            or(
              sql`${pages.bodyMd} like '%[[%' and not exists (select 1 from ${links} where ${links.fromPageId} = ${pages.id})`,
              sql`${pages.bodyMd} like '%/sessions/%' and not exists (select 1 from ${citations} where ${citations.fromPageId} = ${pages.id})`,
            ),
          ),
        )
        .orderBy(asc(pages.id))
        .limit(batchSize)
        .for('update');
      for (const r of rows) {
        await indexWikiLinks(tx, r.id, r.bodyMd, r.sessionId);
        if (wikiLinkTargets(r.bodyMd).length || wikiCitations(r.bodyMd, r.sessionId).length)
          indexed++;
      }
      return rows;
    });
    if (batch.length < batchSize) return indexed;
    after = batch[batch.length - 1]!.id;
  }
}

/** The [[link]] targets of a body that name no live page it can link (as written). */
export async function unresolvedTargets(
  db: Ctx['db'],
  layer: Layer,
  bodyMd: string,
): Promise<string[]> {
  const targets = wikiLinkTargets(bodyMd);
  if (!targets.length) return [];
  const byName = await wikiNames(db, layer);
  return targets.filter((t) => !byName.has(normTitle(t)));
}

/** First paragraph of a body, skipping headings, capped at 400 characters. */
export function firstParagraph(bodyMd: string): string {
  for (const block of bodyMd.split(/\n\s*\n/)) {
    const text = block
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join(' ')
      .trim();
    if (text) return text.length > 400 ? `${text.slice(0, 399)}…` : text;
  }
  return '';
}

/** At most this many backlinks are listed on a page; backlinkCount has the full number. */
const BACKLINK_LIMIT = 50;

async function fullPage(ctx: Ctx, row: PageRow): Promise<WikiPage> {
  const [summary] = await summaries(ctx, [row]);
  const linking = await linkingTo(ctx, row);
  if (!linking) return { ...summary!, bodyMd: row.bodyMd, backlinks: [], backlinkCount: 0 };
  const where = and(live, linking);
  const backlinks = await ctx.db
    .select({ id: pages.id, title: pages.title, kind: pages.kind, showId: pages.showId })
    .from(pages)
    .where(where)
    .orderBy(asc(pages.title), asc(pages.id))
    .limit(BACKLINK_LIMIT);
  const [{ count } = { count: 0 }] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(pages)
    .where(where);
  return { ...summary!, bodyMd: row.bodyMd, backlinks, backlinkCount: count };
}

/**
 * Condition on `pages` for the live pages whose [[links]] resolve to `row` (itself excluded), from
 * the link index; undefined when nothing links it. Links resolve as in the renderer and
 * wiki.lint: by normTitle, titles winning over aliases — resolved here, at read time, so renames
 * and alias changes need no reindex. A show page is linked only from its show. A team page is
 * linked from team pages and from pages of the team's shows (those the actor can read) whose show
 * has no page of that name itself.
 */
async function linkingTo(ctx: Ctx, row: PageRow): Promise<SQL | undefined> {
  const layer = await layerOf(ctx.db, row);
  const byName = await wikiNames(ctx.db, layer);
  const names = [...byName].filter(([, id]) => id === row.id).map(([n]) => n);
  if (!names.length) return undefined;
  const linkers = ctx.db
    .select({ id: links.fromPageId })
    .from(links)
    .where(inArray(links.targetNorm, names));
  if (layer.showId) {
    // Team pages link down to a show page by a name the team wiki doesn't take and no other show uses.
    const fromTeam = [...(await wikiNames(ctx.db, { showId: null, teamId: layer.teamId }))]
      .filter(([, id]) => id === row.id)
      .map(([n]) => n);
    return and(
      ne(pages.id, row.id),
      or(
        and(eq(pages.showId, layer.showId), inArray(pages.id, linkers)),
        fromTeam.length
          ? and(
              isNull(pages.showId),
              eq(pages.teamId, layer.teamId),
              inArray(
                pages.id,
                ctx.db
                  .select({ id: links.fromPageId })
                  .from(links)
                  .where(inArray(links.targetNorm, fromTeam)),
              ),
            )
          : undefined,
      ),
    );
  }
  const fromShows = await ctx.db
    .select({ id: pages.id, showId: pages.showId, norm: links.targetNorm })
    .from(links)
    .innerJoin(pages, eq(pages.id, links.fromPageId))
    .innerJoin(shows, eq(shows.id, pages.showId))
    .where(
      and(
        live,
        eq(shows.teamId, layer.teamId),
        inArray(links.targetNorm, names),
        readableShowCondition(ctx, pages.showId as never),
      ),
    );
  const shadowed = await shadowedNames(ctx.db, [...new Set(fromShows.map((r) => r.showId!))]);
  const ids = [
    ...new Set(fromShows.filter((r) => !shadowed.get(r.showId!)?.has(r.norm)).map((r) => r.id)),
  ];
  return and(
    ne(pages.id, row.id),
    or(
      and(isNull(pages.showId), eq(pages.teamId, layer.teamId), inArray(pages.id, linkers)),
      ids.length ? inArray(pages.id, ids) : undefined,
    ),
  );
}

/** Per show: the names its own pages take, which hide team pages of those names in its links. */
async function shadowedNames(db: Ctx['db'], showIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!showIds.length) return out;
  for (const p of await db
    .select({ showId: pages.showId, title: pages.title, aliases: pages.aliases })
    .from(pages)
    .where(and(live, inArray(pages.showId, showIds)))) {
    const set = out.get(p.showId!) ?? new Set<string>();
    set.add(normTitle(p.title));
    for (const a of p.aliases) set.add(normTitle(a));
    out.set(p.showId!, set);
  }
  return out;
}

async function loadPage(ctx: Ctx, pageId: string, need: 'read' | 'write') {
  const [row] = await ctx.db
    .select()
    .from(pages)
    .where(and(eq(pages.id, pageId), live));
  if (!row) throw notFound('Wiki page');
  if (row.showId) await requireShow(ctx, row.showId, need);
  else await requireTeamRole(ctx, row.teamId!, 'member');
  return row;
}

async function addRevision(ctx: Ctx, row: PageRow) {
  await ctx.db.insert(revisions).values({
    pageId: row.id,
    revision: row.revision,
    title: row.title,
    kind: row.kind,
    bodyMd: row.bodyMd,
    aliases: row.aliases,
    authorId: ctx.actor.user.id,
    via: ctx.actor.via,
  });
}

/**
 * Next revision number for a page. Undo restores `pages.revision` to an older value but keeps the
 * revision rows, so the next one follows the highest stored revision, not the page's counter.
 */
async function nextRevision(ctx: Ctx, row: PageRow): Promise<number> {
  const [r] = await ctx.db
    .select({ max: sql<number | null>`max(${revisions.revision})` })
    .from(revisions)
    .where(eq(revisions.pageId, row.id));
  return Math.max(row.revision, r?.max ?? 0) + 1;
}

/**
 * With `baseRevision` (the revision an edit started from), lock the page row for the rest of the
 * transaction and fail with conflict — naming the current revision and its last change — when the
 * page has moved on since. Returns the locked, current row to save over.
 */
async function lockAtRevision(
  ctx: Ctx,
  row: PageRow,
  baseRevision: number | undefined,
): Promise<PageRow> {
  if (baseRevision === undefined) return row;
  const [current] = await ctx.db
    .select()
    .from(pages)
    .where(and(eq(pages.id, row.id), live))
    .for('update');
  if (!current) throw notFound('Wiki page');
  if (current.revision === baseRevision) return current;
  const [last] = await ctx.db
    .select({
      actorId: schema.changes.actorId,
      via: schema.changes.via,
      clientName: schema.changes.clientName,
      at: schema.changes.at,
    })
    .from(schema.changes)
    .where(and(eq(schema.changes.entity, 'wiki_page'), eq(schema.changes.entityId, row.id)))
    .orderBy(desc(schema.changes.at), desc(schema.changes.id))
    .limit(1);
  const actorId = last?.actorId ?? current.updatedBy;
  const name = actorId ? (await userRefs(ctx.db, [actorId])).get(actorId)?.name : undefined;
  const by =
    last?.via === 'mcp'
      ? ` by ${last.clientName ?? 'an agent'}${name ? ` (acting for ${name})` : ''}`
      : name
        ? ` by ${name}`
        : '';
  // Agents get the time and what to do next; the web editor shows its own options.
  const at = (last?.at ?? current.updatedAt)?.toISOString();
  const agent = ctx.actor.via === 'mcp';
  throw conflict(
    `The page “${current.title}” changed since revision ${baseRevision}: it is now revision ${current.revision}, last changed${by}${agent && at ? ` at ${at}` : ''}. Nothing was saved.` +
      (agent
        ? ` Read it again (wiki_get), redo your edit on the current text and send baseRevision ${current.revision}.`
        : ''),
  );
}

/**
 * Find a live page by title or alias (normTitle): with `own`, among the layer's own pages; else
 * resolved like a [[link]] on a page of the layer (a show's pages, then the team's).
 */
async function findByTitle(
  ctx: Ctx,
  layer: Layer,
  title: string,
  own = true,
): Promise<PageRow | undefined> {
  const id = (await wikiNames(ctx.db, layer, own)).get(normTitle(title));
  if (!id) return undefined;
  const [row] = await ctx.db
    .select()
    .from(pages)
    .where(and(live, eq(pages.id, id)));
  return row;
}

defineOp({
  name: 'wiki.list',
  description:
    'Wiki pages of a show (people, topics, recurring bits, session recaps, answered questions) — showId from shows_list — or, with teamId instead (from teams_list), of the team\'s shared wiki: people, bits and topics that span its shows, which every show page can [[link]] by title. Sorted by kind then title, as { pages, total, nextOffset }. Paged: limit (default 50, max 200) and offset; while nextOffset is not null, call again with offset = nextOffset. Metadata only by default. Bulk read: include "summary" adds each page\'s first paragraph (headings skipped, max 400 chars); include "body" adds every page\'s full bodyMd (several KB each) — narrow it with kind (e.g. "session" for all recaps, "question" for questions already answered — check these before answering one again) and a smaller limit. linksTo (a pageId of this show, from wiki_list / wiki_get) keeps the pages whose [[links]] point to that page: its full backlinks list (wiki_get lists only the first 50). ' +
    "citesSession (a sessionId of this show, from sessions_list) keeps the pages that cite that session (any citation form, any page kind) and adds to each page `citations`: [{ startSec, endSec?, label }] in body order, in seconds from the session start, plus `citationTotal`: that session's citations across all matching pages. Use it to see what the wiki already says about a session before answering again or rewriting its recap. " +
    'countOnly: true (with citesSession) gives each page `citationCount` instead of `citations`; with limit 1, `total` (citing pages) and `citationTotal` measure coverage in one small call.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(
    ctx,
    { showId, teamId, kind, include, linksTo, citesSession, countOnly, limit = 50, offset = 0 },
  ): Promise<WikiList> {
    const layer = await requireLayer(ctx, { showId, teamId }, 'read');
    let linking: SQL | undefined;
    if (linksTo) {
      const target = await loadPage(ctx, linksTo, 'read');
      const targetLayer = await layerOf(ctx.db, target);
      // A team page is linked from show pages too: list those of this show.
      if (
        !sameLayer(targetLayer, layer) &&
        !(targetLayer.showId === null && targetLayer.teamId === layer.teamId)
      )
        throw badRequest('linksTo is a page no page of this wiki can link.');
      linking = await linkingTo(ctx, target);
      if (!linking) return { pages: [], total: 0, nextOffset: null };
    }
    if (countOnly && !citesSession) throw badRequest('countOnly needs citesSession.');
    if (citesSession) {
      const { session, show } = await requireSession(ctx, citesSession, 'read');
      if (layer.showId ? session.showId !== layer.showId : show.teamId !== layer.teamId)
        throw badRequest('citesSession is a session of another show.');
    }
    const where = and(
      live,
      inLayer(layer),
      kind ? eq(pages.kind, kind) : undefined,
      linking,
      citesSession
        ? inArray(
            pages.id,
            ctx.db
              .select({ id: citations.fromPageId })
              .from(citations)
              .where(eq(citations.sessionId, citesSession)),
          )
        : undefined,
    );
    const [{ total } = { total: 0 }] = await ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(pages)
      .where(where);
    const rows = await ctx.db
      .select()
      .from(pages)
      .where(where)
      .orderBy(asc(pages.kind), asc(pages.title), asc(pages.id))
      .limit(limit)
      .offset(offset);
    let list: WikiListItem[] = await summaries(ctx, rows);
    let citationTotal: number | undefined;
    if (citesSession) {
      const [{ n } = { n: 0 }] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(citations)
        .where(
          and(
            eq(citations.sessionId, citesSession),
            inArray(citations.fromPageId, ctx.db.select({ id: pages.id }).from(pages).where(where)),
          ),
        );
      citationTotal = n;
    }
    if (citesSession && countOnly && rows.length) {
      const counts = new Map<string, number>();
      for (const c of await ctx.db
        .select({ id: citations.fromPageId, n: sql<number>`count(*)::int` })
        .from(citations)
        .where(
          and(
            eq(citations.sessionId, citesSession),
            inArray(
              citations.fromPageId,
              rows.map((r) => r.id),
            ),
          ),
        )
        .groupBy(citations.fromPageId))
        counts.set(c.id, c.n);
      list = list.map((p) => ({ ...p, citationCount: counts.get(p.id) ?? 0 }));
    } else if (citesSession && rows.length) {
      const ranges = new Map<string, NonNullable<WikiListItem['citations']>>();
      for (const c of await ctx.db
        .select()
        .from(citations)
        .where(
          and(
            eq(citations.sessionId, citesSession),
            inArray(
              citations.fromPageId,
              rows.map((r) => r.id),
            ),
          ),
        )
        .orderBy(asc(citations.fromPageId), asc(citations.ord))) {
        const of = ranges.get(c.fromPageId) ?? [];
        of.push({
          startSec: c.startSec,
          ...(c.endSec != null ? { endSec: c.endSec } : {}),
          label: c.label,
        });
        ranges.set(c.fromPageId, of);
      }
      list = list.map((p) => ({ ...p, citations: ranges.get(p.id) ?? [] }));
    }
    const nextOffset = offset + rows.length < total ? offset + rows.length : null;
    if (include === 'body')
      return {
        pages: list.map((p, i) => ({ ...p, bodyMd: rows[i]!.bodyMd })),
        total,
        nextOffset,
        ...(citationTotal != null ? { citationTotal } : {}),
      };
    if (include === 'summary')
      return {
        pages: list.map((p, i) => ({ ...p, summary: firstParagraph(rows[i]!.bodyMd) })),
        total,
        nextOffset,
        ...(citationTotal != null ? { citationTotal } : {}),
      };
    return {
      pages: list,
      total,
      nextOffset,
      ...(citationTotal != null ? { citationTotal } : {}),
    };
  },
});

/** Slack for rounding when a citation's range is compared with the session's audio end. */
const AUDIO_END_SLACK_SEC = 1;

/**
 * Audio end (seconds from the session start) of the given sessions a page of this layer may cite
 * (the show's sessions; for the team wiki, those of every show of the team): null for a session
 * without measured audio; other ids are absent.
 */
async function sessionAudioEnds(
  ctx: Ctx,
  layer: Layer,
  ids: string[],
): Promise<Map<string, number | null>> {
  const audioEnd = new Map<string, number | null>();
  if (ids.length)
    for (const s of await ctx.db
      .select({
        id: sessions.id,
        // Raw SQL: drizzle leaves columns unqualified in a single-table select, so ${sessions.id}
        // would bind to the subquery's own id.
        end: sql<
          number | null
        >`(select max(a.start_sec + a.duration_sec)::float from audio_segments a where a.session_id = sessions.id and a.status <> 'failed')`,
      })
      .from(sessions)
      .where(
        and(
          layer.showId
            ? eq(sessions.showId, layer.showId)
            : inArray(
                sessions.showId,
                ctx.db.select({ id: shows.id }).from(shows).where(eq(shows.teamId, layer.teamId)),
              ),
          inArray(sessions.id, ids),
        ),
      ))
      audioEnd.set(s.id, s.end);
  return audioEnd;
}

/** A citation `to` at most this far past its session's audio end is clamped to the end on save. */
const CLAMP_PAST_END_SEC = 5;

/**
 * A body about to be saved (wiki.upsert / wiki.patch) with every citation `to` that overshoots its
 * session's audio end by at most CLAMP_PAST_END_SEC set to that end (rounded down to 0.1 s), the
 * usual result of rounding the last transcript line up, and the citations so changed (reported by
 * the save). Larger overshoots are real mistakes (wrong session or time) that clamping would hide:
 * they are saved as written and wiki.lint reports them as past_end. A citation without `to` whose
 * `t` is past the end is never clamped (moving its start would change what it cites); it stays
 * past_end too.
 */
async function clampCitationEnds(
  ctx: Ctx,
  layer: Layer,
  bodyMd: string,
  pageSessionId: string | null,
): Promise<{ bodyMd: string; clamped: WikiSavedCitations['clampedCitations'] }> {
  const clamped: WikiSavedCitations['clampedCitations'] = [];
  const ids = [...new Set(wikiCitations(bodyMd, pageSessionId).map((c) => c.sessionId))];
  if (!ids.length) return { bodyMd, clamped };
  const audioEnd = await sessionAudioEnds(ctx, layer, ids);
  const body = setCitationEnds(
    bodyMd,
    (c) => {
      const end = audioEnd.get(c.sessionId);
      if (end == null || c.endSec == null || c.endSec <= end || c.endSec > end + CLAMP_PAST_END_SEC)
        return undefined;
      const to = Math.floor(end * 10) / 10;
      if (to <= c.startSec) return undefined;
      clamped.push({ ...c, endSec: to, sentEndSec: c.endSec });
      return to;
    },
    pageSessionId,
  );
  return { bodyMd: body, clamped };
}

/** `H:MM:SS` or `M:SS`, fraction allowed (the web shows a citation's range as HH:MM:SS). */
const TIMECODE = String.raw`(?:\d{1,2}:[0-5]\d|\d{1,3}):[0-5]\d(?:\.\d+)?`;
/** A label that starts with a timecode or timecode range: "01:01:01", "[1:01:01–1:02:00] …". */
const TIMECODE_LABEL = new RegExp(
  String.raw`^\[?(${TIMECODE})(?:\s*[–—-]\s*(${TIMECODE}))?(?![\d:.])`,
);
const timecodeSec = (tc: string) => tc.split(':').reduce((sec, part) => sec * 60 + Number(part), 0);

/**
 * True when a citation's label starts with a timecode that is not its range (more than a second
 * off `t`, or off `to` for a range label), e.g. [00:01:01](…?t=3661.5): the chip plays the right
 * range, but the Markdown misleads anyone reading the source or an export.
 */
function labelMismatch(c: WikiCitation): boolean {
  const m = TIMECODE_LABEL.exec(c.label);
  if (!m) return false;
  if (Math.abs(timecodeSec(m[1]!) - c.startSec) > 1) return true;
  return m[2] != null && c.endSec != null && Math.abs(timecodeSec(m[2]) - c.endSec) > 1;
}

/** `sec` as a timecode shaped like `like` (H:MM:SS, HH:MM:SS, M:SS or MM:SS), fraction dropped. */
function timecodeLike(sec: number, like: string): string {
  const s = Math.floor(sec);
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const parts = like.split(':');
  if (parts.length === 3 || s >= 3600)
    return `${pad(Math.floor(s / 3600), parts.length === 3 ? parts[0]!.length : 2)}:${pad(Math.floor(s / 60) % 60, 2)}:${pad(s % 60, 2)}`;
  return `${pad(Math.floor(s / 60), parts[0]!.length)}:${pad(s % 60, 2)}`;
}

/** A written label's leading timecode (or range), as TIMECODE_LABEL reads it but on raw Markdown. */
const WRITTEN_TIMECODE_LABEL = new RegExp(
  String.raw`^(\\?\[)?(${TIMECODE})(?:(\s*[–—-]\s*)(${TIMECODE}))?(?![\d:.])`,
);

/**
 * A body about to be saved with the leading timecode of every label_mismatch citation rewritten to
 * its range (the start, and the end for a range label), keeping the rest of the label and the
 * timecode's shape; and the citations so changed. Agents often label a citation with a rounded or
 * neighbouring time; the range is what plays, so the label follows it.
 */
function relabelCitations(
  bodyMd: string,
  pageSessionId: string | null,
): { bodyMd: string; relabeled: WikiSavedCitations['relabeledCitations'] } {
  const relabeled: WikiSavedCitations['relabeledCitations'] = [];
  const body = setCitationLabels(
    bodyMd,
    (c, written) => {
      if (!labelMismatch(c)) return undefined;
      const m = WRITTEN_TIMECODE_LABEL.exec(written);
      if (!m) return undefined;
      const start = timecodeLike(c.startSec, m[2]!);
      const end =
        m[4] !== undefined && c.endSec != null ? `${m[3]}${timecodeLike(c.endSec, m[4])}` : '';
      const next = `${m[1] ?? ''}${start}${end}${written.slice(m[0].length)}`;
      relabeled.push({ ...c, label: next.replace(/\\(.)/g, '$1').trim(), sentLabel: c.label });
      return next;
    },
    pageSessionId,
  );
  return { bodyMd: body, relabeled };
}

/**
 * What is wrong with one citation, given its session's audio end from sessionAudioEnds (undefined:
 * not a session the page may cite). The session must be in this show — any show of the team for a
 * team page — (another show's session counts as
 * unknown, revealing nothing about it), `to` must be after `t`, the range must end within the
 * session's audio (sessions without measured audio are not range-checked), and a label that
 * starts with a timecode must match the range.
 */
function citationProblem(
  c: WikiCitation,
  end: number | null | undefined,
): WikiCitationProblem | null {
  if (end === undefined) return 'unknown_session';
  if (c.endSec != null && c.endSec <= c.startSec) return 'bad_range';
  if (end != null && (c.endSec ?? c.startSec) > end + AUDIO_END_SLACK_SEC) return 'past_end';
  if (labelMismatch(c)) return 'label_mismatch';
  return null;
}

/**
 * Citation count and bad citations of a page body just saved by wiki.upsert / wiki.patch, with
 * the citations clampCitationEnds changed on the way.
 */
async function savedCitations(
  ctx: Ctx,
  layer: Layer,
  bodyMd: string,
  pageSessionId: string | null,
  clampedCitations: WikiSavedCitations['clampedCitations'],
  relabeledCitations: WikiSavedCitations['relabeledCitations'] = [],
): Promise<WikiSavedCitations> {
  const cites = wikiCitations(bodyMd, pageSessionId);
  const ids = [...new Set(cites.map((c) => c.sessionId))];
  const audioEnd = await sessionAudioEnds(ctx, layer, ids);
  const badCitations: WikiSavedCitations['badCitations'] = [];
  for (const c of cites) {
    const problem = citationProblem(c, audioEnd.get(c.sessionId));
    if (problem) badCitations.push({ ...c, problem });
  }
  return { citationCount: cites.length, badCitations, clampedCitations, relabeledCitations };
}

/**
 * Check every citation of a show's live pages against its sessions (citationProblem). Reads the
 * citation index; no bodies are parsed.
 */
async function lintCitations(
  ctx: Ctx,
  layer: Layer,
): Promise<{ count: number; bad: WikiLint['badCitations'] }> {
  const cited: { id: string; title: string; kind: PageRow['kind']; cites: WikiCitation[] }[] = [];
  for (const c of await ctx.db
    .select({
      id: pages.id,
      title: pages.title,
      kind: pages.kind,
      sessionId: citations.sessionId,
      startSec: citations.startSec,
      endSec: citations.endSec,
      label: citations.label,
    })
    .from(citations)
    .innerJoin(pages, eq(pages.id, citations.fromPageId))
    .where(and(live, inLayer(layer)))
    .orderBy(asc(pages.kind), asc(pages.title), asc(pages.id), asc(citations.ord))) {
    const { id, title, kind, endSec, ...rest } = c;
    let page = cited[cited.length - 1];
    if (page?.id !== id) {
      page = { id, title, kind, cites: [] };
      cited.push(page);
    }
    page.cites.push({ ...rest, ...(endSec != null ? { endSec } : {}) });
  }
  const ids = [...new Set(cited.flatMap((r) => r.cites.map((c) => c.sessionId)))];
  const audioEnd = await sessionAudioEnds(ctx, layer, ids);
  let count = 0;
  const bad: WikiLint['badCitations'] = [];
  for (const r of cited) {
    const problems: WikiLint['badCitations'][number]['citations'] = [];
    for (const c of r.cites) {
      count++;
      const problem = citationProblem(c, audioEnd.get(c.sessionId));
      if (problem) problems.push({ ...c, problem });
    }
    if (problems.length)
      bad.push({ pageId: r.id, title: r.title, kind: r.kind, citations: problems });
  }
  return { count, bad };
}

defineOp({
  name: 'wiki.lint',
  description:
    'Check the links of a whole show wiki (showId) or of the team\'s shared wiki (teamId) in one call, as the wiki renders them. Read-only. unresolved: pages with [[Target]] / [[Target|label]] links (also [[Target\\|label]] in table cells; links inside code are ignored) matching no page title or alias (case-insensitive, spaces collapsed) — in a show, of the show\'s pages or the team wiki\'s; on a team page, of team pages, then of pages in the team\'s shows for names exactly one show uses (a name two shows use stays unresolved: link a more specific title or alias) — with the missing targets as written — create those pages with wiki_upsert or fix the links. orphans: person, topic and bit pages no other page links to (recaps and question pages are left out; a team page linked only from show pages, or a show page linked only from team pages, is not an orphan). badCitations: pages whose citations (any form, see wiki_upsert) are wrong, each with problem "unknown_session" (no such session in this show — for the team wiki, in any show of the team), "bad_range" (to is not greater than t), "past_end" (the range ends after the session\'s audio, audioSeconds in sessions_get; sessions without audio are not checked; saves clamp a `to` at most 5 s past the end, so these overshoot by more or are older) or "label_mismatch" (the label starts with a timecode, e.g. 01:01:01 or 1:01:01–1:02:00, HH:MM:SS from the session start, more than a second off t / to) — fix them with wiki_patch (saves now rewrite mismatched timecode labels themselves, so label_mismatch only shows on pages saved before that). counts: pages, distinct links, unresolved links, orphans, citations, bad citations.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { showId, teamId }): Promise<WikiLint> {
    const layer = await requireLayer(ctx, { showId, teamId }, 'read');
    const rows = await ctx.db
      .select({ id: pages.id, title: pages.title, kind: pages.kind })
      .from(pages)
      .where(and(live, inLayer(layer)))
      .orderBy(asc(pages.kind), asc(pages.title));
    const byName = await wikiNames(ctx.db, layer);
    // The link index of the layer's live pages, in each body's order (no bodies are parsed).
    const targetsOf = new Map<string, { target: string; norm: string }[]>();
    for (const l of await ctx.db
      .select({ from: links.fromPageId, target: links.target, norm: links.targetNorm })
      .from(links)
      .innerJoin(pages, eq(pages.id, links.fromPageId))
      .where(and(live, inLayer(layer)))
      .orderBy(asc(links.fromPageId), asc(links.ord))) {
      const list = targetsOf.get(l.from) ?? [];
      list.push(l);
      targetsOf.set(l.from, list);
    }
    const linked = new Set<string>();
    const unresolved: WikiLint['unresolved'] = [];
    let linkCount = 0;
    let unresolvedLinks = 0;
    for (const r of rows) {
      const missing: string[] = [];
      for (const t of targetsOf.get(r.id) ?? []) {
        linkCount++;
        const target = byName.get(t.norm);
        if (!target) missing.push(t.target);
        else if (target !== r.id) linked.add(target);
      }
      if (missing.length) {
        unresolvedLinks += missing.length;
        unresolved.push({ pageId: r.id, title: r.title, kind: r.kind, targets: missing });
      }
    }
    // A show page is also linked from team pages that reach it (wikiNames for the team layer).
    if (layer.showId) {
      const teamNames = await wikiNames(ctx.db, { showId: null, teamId: layer.teamId });
      for (const l of await ctx.db
        .select({ norm: links.targetNorm })
        .from(links)
        .innerJoin(pages, eq(pages.id, links.fromPageId))
        .where(and(live, isNull(pages.showId), eq(pages.teamId, layer.teamId)))) {
        const target = teamNames.get(l.norm);
        if (target) linked.add(target);
      }
    }
    // Team pages are also linked from the team's shows, where no show page takes the name.
    if (!layer.showId) {
      const fromShows = await ctx.db
        .select({ showId: pages.showId, norm: links.targetNorm })
        .from(links)
        .innerJoin(pages, eq(pages.id, links.fromPageId))
        .innerJoin(shows, eq(shows.id, pages.showId))
        .where(and(live, eq(shows.teamId, layer.teamId)));
      const shadowed = await shadowedNames(ctx.db, [...new Set(fromShows.map((r) => r.showId!))]);
      for (const l of fromShows) {
        const target = byName.get(l.norm);
        if (target && !shadowed.get(l.showId!)?.has(l.norm)) linked.add(target);
      }
    }
    const orphans = rows
      .filter((r) => r.kind !== 'session' && r.kind !== 'question' && !linked.has(r.id))
      .map((r) => ({ pageId: r.id, title: r.title, kind: r.kind }));
    const cites = await lintCitations(ctx, layer);
    return {
      unresolved,
      orphans,
      badCitations: cites.bad,
      counts: {
        pages: rows.length,
        links: linkCount,
        unresolvedLinks,
        orphans: orphans.length,
        citations: cites.count,
        badCitations: cites.bad.reduce((n, p) => n + p.citations.length, 0),
      },
    };
  },
});

defineOp({
  name: 'wiki.get',
  description:
    'Read a wiki page by pageId, or by showId + title (aliases match too; case and extra spaces are ignored, as in [[links]]; a title the show has no page for finds the team wiki\'s page, just as a [[link]] on a show page does — teamId is then set on the result), or by teamId + title for the team\'s shared wiki. Includes backlinkCount and backlinks (the pages linking here, first 50 by title; when backlinkCount is larger, wiki_list with linksTo = this pageId pages through all of them). To read many pages in one call use wiki_list with include "summary" or "body".',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { pageId, showId, teamId, title }) {
    if (pageId) return fullPage(ctx, await loadPage(ctx, pageId, 'read'));
    if ((!showId && !teamId) || !title)
      throw badRequest('Give pageId, or showId (or teamId) and title.');
    const layer = await requireLayer(ctx, { showId, teamId }, 'read');
    const row = await findByTitle(ctx, layer, title, !layer.showId);
    if (!row) throw notFound('Wiki page');
    return fullPage(ctx, row);
  },
});

const UPLOAD_TYPE = 'text/markdown';
/** Bytes a body upload may hold: 100000 characters of UTF-8 at worst. */
const UPLOAD_MAX_BYTES = 400_000;

defineOp({
  name: 'wiki.createUpload',
  description:
    'Send a long page body as a file instead of inlining it in a tool call (saves output tokens when you drafted the Markdown in a local file). showId from shows_list (needs write access to the show), or teamId for a page of the team wiki. Returns { uploadId, uploadUrl, headers, expiresAt }: PUT the UTF-8 Markdown file to uploadUrl with exactly headers within 15 minutes (e.g. `curl -sf -X PUT -H "Content-Type: text/markdown" --data-binary @recap.md "<uploadUrl>"`), then pass uploadId as bodyUploadId to wiki_upsert (instead of bodyMd) or as appendUploadId to wiki_patch (instead of append) for a page of this wiki. The file is read exactly as bodyMd would be (at most 100000 characters, same citation forms) and deleted once a save uses it, so each uploadId works once; an unused one is removed after a few hours. Writes nothing else.',
  kind: 'write',
  surfaces: ['mcp'],
  async run(ctx, { showId, teamId }) {
    const layer = await requireLayer(ctx, { showId, teamId }, 'write');
    requireStorage();
    const uploadId = newId('wup');
    return {
      uploadId,
      uploadUrl: await presignUpload(uploadKey(layer, uploadId), UPLOAD_TYPE),
      headers: { 'Content-Type': UPLOAD_TYPE },
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SEC * 1000).toISOString(),
    };
  },
});

const uploadKey = (layer: Layer, uploadId: string) =>
  wikiUploadKeyFor(layer.showId ? { showId: layer.showId } : { teamId: layer.teamId }, uploadId);

/** The text of a wiki.createUpload file for this wiki, and its key (delete it once saved). */
async function readUpload(
  layer: Layer,
  uploadId: string,
  field: string,
): Promise<{ text: string; key: string }> {
  requireStorage();
  const missing = () =>
    conflict(
      `Nothing was uploaded for ${field} ${uploadId} in this wiki: PUT the file to the uploadUrl of wiki_createUpload first (it works for 15 minutes), or it was already used by a save — create a new upload.`,
    );
  if (!/^wup_[0-9a-z]+$/.test(uploadId)) throw missing();
  const key = uploadKey(layer, uploadId);
  const head = await headObject(key);
  if (!head) throw missing();
  if (head.size > UPLOAD_MAX_BYTES)
    throw badRequest(`The ${field} file is larger than ${UPLOAD_MAX_BYTES} bytes.`);
  const bytes = await getObjectBytes(key);
  if (!bytes) throw missing();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw badRequest(`The ${field} file is not UTF-8 text.`);
  }
  text = text.replace(/^\uFEFF/, '');
  if (text.length > 100_000) throw badRequest(`The ${field} file holds over 100000 characters.`);
  return { text, key };
}

/** Remove a body upload once its save went through; a leftover is swept later. */
async function dropUpload(key: string | undefined) {
  if (!key) return;
  await deleteObject(key).catch((e) =>
    console.warn(`could not delete wiki upload ${key}: ${(e as Error).message}`),
  );
}

defineOp({
  name: 'wiki.upsert',
  description:
    'Create or update a wiki page in a show wiki (showId) or in the team\'s shared wiki (teamId, from teams_list; every team member can edit it). Use the team wiki for people, recurring bits and topics that appear in several shows of the team: a [[link]] on any show page reaches a team page by title or alias unless that show has its own page of that name. A team page can also [[link]] a show page (a hub, recap or bit) by its title or alias when exactly one of the team\'s shows has a page of that name. Team pages can\'t be recaps (kind "session") and have no sessionId, so cite with the long or @<sessionId>: forms; they may cite sessions of any show of the team. Creating a show page whose title is a team page\'s fails with conflict (edit the team page instead, or move it with wiki_move). Without pageId, a page with the same title (or alias) in that wiki is updated (keeping its title), otherwise a new one is created; pass pageId to rename. bodyMd is raw Markdown, stored as sent (except the citation clamping below): write real newlines and quotes, not JSON escapes like \\n or \\". For a long body you drafted in a local file, pass bodyUploadId (from wiki_createUpload, after PUTting the file) instead of bodyMd so you do not resend it inline. Link pages with [[Title]] or [[Title|label]]. Kind "session" = a recap tied to sessionId. Kind "question" = an answered question: title = the question as asked (e.g. "When did Dana talk about her dog?"), bodyMd = the answer with a citation for every claim. ' +
    "Citations (prefer them to bare timecodes on every page kind) link a range of a session: [label](/sessions/<sessionId>?t=<startSec>&to=<endSec>), seconds from the session start (the @seconds of transcript_text), `to` optional and greater than t, e.g. [Dana on the dog](/sessions/ses_abc?t=754.2&to=811). The range must end within the session's audio (audioSeconds in sessions_get / sessions_list); a `to` up to 5 s past the end is clamped to it on save. The web shows a chip that plays the range. Short forms save tokens and work the same: on a page with a sessionId (every recap) [label](@<startSec>-<endSec>) or [@<startSec>-<endSec>] (no label) cite that session; on any page [label](@<sessionId>:<startSec>-<endSec>) or [@<sessionId>:<startSec>-<endSec>]; -<endSec> is optional. A sessionless short form on a page without a sessionId is a bad_request. " +
    'Every save keeps a revision; to change a few sentences use wiki_patch instead of resending the body. baseRevision (optional; `revision` from wiki_get / wiki_list): when the page has moved on since (another save, or an undo) the call fails with conflict naming the current revision and who changed it, and nothing is saved — re-read, redo the edit, retry. Send it when rewriting a page you read earlier so a concurrent human edit is not overwritten; without it the last write wins. ' +
    'Returns the saved page with body and backlinks, but agents get only { id, title, kind, revision, unresolvedLinks, citationCount, badCitations, clampedCitations, relabeledCitations } by default (compact; pass compact: false for the page), unresolvedLinks = [[link]] targets matching no page title or alias yet (create those pages or fix the links). Both shapes include citationCount (citations in the saved body, repeats counted); badCitations, the citations wiki_lint would flag, in body order: [{ sessionId, startSec, endSec?, label, problem }], problem "unknown_session" | "bad_range" | "past_end" | "label_mismatch" (see wiki_lint; the page is saved anyway, fix with wiki_patch; a `to`-less citation past the audio end is reported as past_end, not clamped); and clampedCitations: [{ sessionId, startSec, endSec (stored), sentEndSec, label }] — when not empty the stored body differs from what you sent, so a later wiki_patch `find` must use the stored `to`; and relabeledCitations: [{ sessionId, startSec, endSec?, label (stored), sentLabel }] — a citation whose label starts with a timecode (HH:MM:SS, or a range) that is more than a second off its range gets that timecode rewritten to the range on save (the rest of the label is kept), so you never need to fix label_mismatch yourself; a later `find` must use the stored label.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, input) {
    const layer = await requireLayer(ctx, input, 'write');
    if (!layer.showId && (input.kind === 'session' || input.sessionId))
      throw badRequest(
        'Team wiki pages are not tied to a session: session recaps (kind "session", sessionId) belong in the show wiki (showId).',
      );
    const upload = input.bodyUploadId
      ? await readUpload(layer, input.bodyUploadId, 'bodyUploadId')
      : undefined;
    const bodyMd = upload?.text ?? input.bodyMd ?? '';
    if (input.kind === 'session' && !input.sessionId)
      throw badRequest('Session pages need a sessionId.');
    if (input.sessionId) {
      const { session } = await requireSession(ctx, input.sessionId, 'read');
      if (session.showId !== layer.showId)
        throw badRequest('That session belongs to another show.');
    }
    const found = input.pageId
      ? await loadPage(ctx, input.pageId, 'write')
      : await findByTitle(ctx, layer, input.title);
    if (found && !sameLayer(await layerOf(ctx.db, found), layer))
      throw badRequest(
        found.showId
          ? 'That page belongs to another show (move it with wiki_move).'
          : 'That page is in the team wiki: pass teamId (or move it with wiki_move).',
      );
    if (!found && input.baseRevision !== undefined)
      throw conflict(
        `No page titled “${input.title}” exists any more (renamed or deleted since revision ${input.baseRevision}). Nothing was saved; find it with wiki_list, or leave out baseRevision to create a new page.`,
      );
    const existing = found && (await lockAtRevision(ctx, found, input.baseRevision));
    const clash = await findByTitle(ctx, layer, input.title);
    if (clash && clash.id !== existing?.id)
      throw conflict(`A page titled “${clash.title}” already exists.`);
    if (layer.showId && normTitle(input.title) !== existing?.titleNorm) {
      const team = await findByTitle(ctx, { showId: null, teamId: layer.teamId }, input.title);
      if (team)
        throw conflict(
          `The team wiki has a page titled “${team.title}” (pageId ${team.id}), which [[${team.title}]] on this show's pages already links. Edit that page (wiki_upsert with teamId), or give this page another title.`,
        );
    }
    // Matched by title/alias (no pageId): keep the canonical title; renaming needs an explicit pageId.
    const title = existing && !input.pageId ? existing.title : input.title;
    const clamp = await clampCitationEnds(
      ctx,
      layer,
      bodyMd,
      input.sessionId ?? existing?.sessionId ?? null,
    );
    const values = {
      kind: input.kind,
      title,
      titleNorm: normTitle(title),
      bodyMd: relabelCitations(clamp.bodyMd, input.sessionId ?? existing?.sessionId ?? null).bodyMd,
      aliases: input.aliases ?? existing?.aliases ?? [],
      sessionId: input.sessionId ?? existing?.sessionId ?? null,
      updatedBy: ctx.actor.user.id,
      updatedAt: new Date(),
    };
    checkShortCitations(values.bodyMd, values.sessionId);
    let row: PageRow;
    if (existing) {
      [row] = (await ctx.db
        .update(pages)
        .set({ ...values, revision: await nextRevision(ctx, existing) })
        .where(eq(pages.id, existing.id))
        .returning()) as [PageRow];
      await ctx.record({
        entity: 'wiki_page',
        entityId: row.id,
        kind: 'update',
        summary: `Edited wiki page “${row.title}”`,
        showId: row.showId,
        teamId: row.teamId,
        sessionId: row.sessionId,
        before: snapshot(existing),
        after: snapshot(row),
      });
    } else {
      [row] = (await ctx.db
        .insert(pages)
        .values({
          id: newId('wiki'),
          showId: layer.showId,
          teamId: layer.showId ? null : layer.teamId,
          ...values,
          createdBy: ctx.actor.user.id,
        })
        .returning()) as [PageRow];
      await ctx.record({
        entity: 'wiki_page',
        entityId: row.id,
        kind: 'create',
        summary: `Created wiki page “${row.title}”`,
        showId: row.showId,
        teamId: row.teamId,
        sessionId: row.sessionId,
        after: snapshot(row),
      });
    }
    await addRevision(ctx, row);
    await indexWikiLinks(ctx.db, row.id, row.bodyMd, row.sessionId);
    const relabeled = relabelCitations(clamp.bodyMd, row.sessionId).relabeled;
    const cited = await savedCitations(
      ctx,
      layer,
      row.bodyMd,
      row.sessionId,
      clamp.clamped,
      relabeled,
    );
    await dropUpload(upload?.key);
    if (input.compact)
      return {
        id: row.id,
        title: row.title,
        kind: row.kind,
        revision: row.revision,
        unresolvedLinks: await unresolvedTargets(ctx.db, layer, row.bodyMd),
        ...cited,
      };
    return { ...(await fullPage(ctx, row)), ...cited };
  },
});

/** Count non-overlapping occurrences of `find` in `text`. */
function occurrences(text: string, find: string): number {
  let n = 0;
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) n++;
  return n;
}

defineOp({
  name: 'wiki.patch',
  description:
    "Fix part of a wiki page without resending its body (pageId from wiki_list / wiki_get; no need to read the page first to append). edits: [{ find, replace, all? }] are exact, case-sensitive replacements applied in order; each `find` must occur exactly once at that point (otherwise bad_request saying how often it matched; add surrounding text to make it unique), and nothing is saved unless every edit applies. all: true replaces every occurrence instead (at least one), e.g. to link every mention at once (find `Dana Lee`, replace `[[Dana Lee]]` — mind text already inside links). append (optional) adds Markdown on a new line at the end; appendUploadId (from wiki_createUpload, after PUTting the file) appends a long section from a file instead. Citations and their short forms are as in wiki_upsert; a citation `to` up to 5 s past its session's audio end is clamped (anywhere in the saved body) and listed in clampedCitations, so a `to=` in a later `find` must match the stored end. Saved as one new revision, undoable from the change log. baseRevision (optional, as in wiki_upsert): if the page has moved on since, conflict and nothing is saved; without it the edits apply to whatever the page holds now. Labels starting with a timecode that is off their range are rewritten to it, as in wiki_upsert. Returns the page summary without the body, plus citationCount, badCitations, clampedCitations and relabeledCitations (as in wiki_upsert); agents get only { id, title, kind, revision, unresolvedLinks, citationCount, badCitations, clampedCitations, relabeledCitations } by default, like wiki_upsert (pass compact: false for the summary), unresolvedLinks = [[link]] targets in the saved body matching no page yet.",
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { pageId, edits, append: appendMd, appendUploadId, baseRevision, compact }) {
    const row = await lockAtRevision(ctx, await loadPage(ctx, pageId, 'write'), baseRevision);
    const layer = await layerOf(ctx.db, row);
    if (!edits.length && !appendMd && !appendUploadId)
      throw badRequest('Give at least one edit, append or appendUploadId.');
    const upload = appendUploadId
      ? await readUpload(layer, appendUploadId, 'appendUploadId')
      : undefined;
    const append = upload?.text ?? appendMd;
    let body = row.bodyMd;
    for (const [i, e] of edits.entries()) {
      const n = occurrences(body, e.find);
      if (n === 0 || (n > 1 && !e.all))
        throw badRequest(
          n === 0
            ? `edits[${i}].find was not found in the page (it must match exactly, including case and whitespace).`
            : `edits[${i}].find matches ${n} times; include more surrounding text so it matches once, or pass all: true to replace every one.`,
        );
      if (e.all) {
        body = body.split(e.find).join(e.replace);
        continue;
      }
      const at = body.indexOf(e.find);
      body = body.slice(0, at) + e.replace + body.slice(at + e.find.length);
    }
    if (append) body = body && !body.endsWith('\n') ? `${body}\n${append}` : body + append;
    const clamp = await clampCitationEnds(ctx, layer, body, row.sessionId);
    const relabel = relabelCitations(clamp.bodyMd, row.sessionId);
    body = relabel.bodyMd;
    if (body.length > 100_000) throw badRequest('The page would exceed 100000 characters.');
    checkShortCitations(body, row.sessionId);
    const [after] = (await ctx.db
      .update(pages)
      .set({
        bodyMd: body,
        revision: await nextRevision(ctx, row),
        updatedBy: ctx.actor.user.id,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, row.id))
      .returning()) as [PageRow];
    await ctx.record({
      entity: 'wiki_page',
      entityId: row.id,
      kind: 'update',
      summary: `Edited wiki page “${row.title}”`,
      showId: row.showId,
      teamId: row.teamId,
      sessionId: row.sessionId,
      before: snapshot(row),
      after: snapshot(after),
    });
    await addRevision(ctx, after);
    await indexWikiLinks(ctx.db, after.id, after.bodyMd, after.sessionId);
    const cited = await savedCitations(
      ctx,
      layer,
      after.bodyMd,
      after.sessionId,
      clamp.clamped,
      relabel.relabeled,
    );
    await dropUpload(upload?.key);
    if (compact)
      return {
        id: after.id,
        title: after.title,
        kind: after.kind,
        revision: after.revision,
        unresolvedLinks: await unresolvedTargets(ctx.db, layer, after.bodyMd),
        ...cited,
      };
    const [summary] = await summaries(ctx, [after]);
    return { ...summary!, ...cited };
  },
});

defineOp({
  name: 'wiki.delete',
  description:
    'Delete a wiki page. It disappears from the wiki, search and links, but keeps its revision history so the deletion can be undone from the change log.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { pageId }) {
    const row = await loadPage(ctx, pageId, 'write');
    const [after] = await ctx.db
      .update(pages)
      .set({ deletedAt: new Date() })
      .where(eq(pages.id, pageId))
      .returning();
    await ctx.record({
      entity: 'wiki_page',
      entityId: row.id,
      kind: 'delete',
      summary: `Deleted wiki page “${row.title}”`,
      showId: row.showId,
      teamId: row.teamId,
      sessionId: row.sessionId,
      before: snapshot(row),
      after: snapshot(after),
    });
    return { deleted: true };
  },
});

defineOp({
  name: 'wiki.revisions',
  description: 'Revision history of a wiki page, newest first.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { pageId }) {
    await loadPage(ctx, pageId, 'read');
    const rows = await ctx.db
      .select()
      .from(revisions)
      .where(eq(revisions.pageId, pageId))
      .orderBy(desc(revisions.revision));
    const users = await userRefs(
      ctx.db,
      rows.map((r) => r.authorId),
    );
    return rows.map((r) => ({
      revision: r.revision,
      title: r.title,
      bodyMd: r.bodyMd,
      author: r.authorId ? (users.get(r.authorId) ?? null) : null,
      via: r.via,
      at: iso(r.at)!,
    }));
  },
});

defineOp({
  name: 'wiki.restore',
  description: 'Restore an earlier revision of a page (as a new revision).',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { pageId, revision }) {
    const row = await loadPage(ctx, pageId, 'write');
    const [rev] = await ctx.db
      .select()
      .from(revisions)
      .where(and(eq(revisions.pageId, pageId), eq(revisions.revision, revision)));
    if (!rev) throw notFound('Revision');
    const [after] = (await ctx.db
      .update(pages)
      .set({
        title: rev.title,
        titleNorm: normTitle(rev.title),
        bodyMd: rev.bodyMd,
        aliases: rev.aliases,
        revision: await nextRevision(ctx, row),
        updatedBy: ctx.actor.user.id,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, pageId))
      .returning()) as [PageRow];
    await addRevision(ctx, after);
    await indexWikiLinks(ctx.db, after.id, after.bodyMd, after.sessionId);
    await ctx.record({
      entity: 'wiki_page',
      entityId: pageId,
      kind: 'update',
      summary: `Restored “${after.title}” to revision ${revision}`,
      showId: row.showId,
      teamId: row.teamId,
      sessionId: row.sessionId,
      before: snapshot(row),
      after: snapshot(after),
    });
    return fullPage(ctx, after);
  },
});

defineOp({
  name: 'wiki.move',
  description:
    "Move a wiki page between a show wiki and the team's shared wiki, keeping its id, body, aliases and revision history (one new revision; undoable from the change log). pageId from wiki_list / wiki_get; then showId to move it into that show's wiki, or teamId (from teams_list, the page's own team) to move it into the team wiki. Use it to promote a person, bit or topic that turns out to span several shows: after the move, [[links]] to it on every show of the team resolve to it (unless a show has its own page of that name), and that show's other pages keep linking it. Session recaps and other pages tied to a session stay in their show. Fails with conflict when the destination already has a page of that title (merge them by hand: copy what you need with wiki_patch, then wiki_delete one); a show page can't take the title of a team page. Citations stay as written: on a team page they may cite sessions of any show of the team; moved into a show, citations of other shows' sessions are reported in badCitations (unknown_session). Agents get the compact result by default, as for wiki_upsert.",
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { pageId, showId, teamId, compact }) {
    const row = await loadPage(ctx, pageId, 'write');
    const from = await layerOf(ctx.db, row);
    const to = await requireLayer(ctx, { showId, teamId }, 'write');
    if (to.teamId !== from.teamId) throw badRequest('Pages move only within their team.');
    if (sameLayer(from, to)) throw badRequest('The page is already in that wiki.');
    if (row.sessionId || row.kind === 'session')
      throw badRequest('A page tied to a session (a recap) stays in its show.');
    const clash = await findByTitle(ctx, to, row.title);
    if (clash)
      throw conflict(
        `${to.showId ? 'That show' : 'The team wiki'} already has a page titled “${clash.title}” (pageId ${clash.id}). Nothing was moved.`,
      );
    if (to.showId) {
      const team = await findByTitle(ctx, { showId: null, teamId: to.teamId }, row.title);
      if (team && team.id !== row.id)
        throw conflict(
          `The team wiki has another page titled “${team.title}” (pageId ${team.id}). Nothing was moved.`,
        );
    }
    const [after] = (await ctx.db
      .update(pages)
      .set({
        showId: to.showId,
        teamId: to.showId ? null : to.teamId,
        revision: await nextRevision(ctx, row),
        updatedBy: ctx.actor.user.id,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, row.id))
      .returning()) as [PageRow];
    await ctx.record({
      entity: 'wiki_page',
      entityId: row.id,
      kind: 'update',
      summary: to.showId
        ? `Moved wiki page “${row.title}” from the team wiki to a show`
        : `Moved wiki page “${row.title}” to the team wiki`,
      // Listed in the show's change log and in the team's.
      showId: from.showId ?? to.showId,
      teamId: to.teamId,
      before: snapshot(row),
      after: snapshot(after),
    });
    await addRevision(ctx, after);
    const cited = await savedCitations(ctx, to, after.bodyMd, null, []);
    if (compact)
      return {
        id: after.id,
        title: after.title,
        kind: after.kind,
        revision: after.revision,
        unresolvedLinks: await unresolvedTargets(ctx.db, to, after.bodyMd),
        ...cited,
      };
    return { ...(await fullPage(ctx, after)), ...cited };
  },
});
