import {
  normTitle,
  type WikiLint,
  type WikiList,
  type WikiPage,
  type WikiPageSummary,
  wikiLinkTargets,
} from '@autologger/contract';
import { and, asc, desc, eq, inArray, isNull, ne, type SQL, sql } from 'drizzle-orm';
import { requireSession, requireShow } from '../core/authz.ts';
import { badRequest, conflict, notFound } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp, snapshot } from '../core/op.ts';
import { type Db, schema } from '../db/client.ts';
import { iso, userRefs } from './map.ts';

const { wikiPages: pages, wikiRevisions: revisions, wikiLinks: links } = schema;
type PageRow = typeof pages.$inferSelect;

/** Deleted pages are kept (with their revisions) for undo, but are invisible everywhere else. */
const live = isNull(pages.deletedAt);

export { normTitle };

async function summaries(ctx: Ctx, rows: PageRow[]): Promise<WikiPageSummary[]> {
  const users = await userRefs(
    ctx.db,
    rows.map((r) => r.updatedBy),
  );
  return rows.map((r) => ({
    id: r.id,
    showId: r.showId,
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
 * Every title and alias of a show's live pages (normalised like the web's link resolver) → the
 * page id it names. Titles win over aliases.
 */
export async function wikiNames(db: Ctx['db'], showId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: pages.id, title: pages.title, aliases: pages.aliases })
    .from(pages)
    .where(and(live, eq(pages.showId, showId)));
  const byName = new Map<string, string>();
  for (const r of rows) byName.set(normTitle(r.title), r.id);
  for (const r of rows)
    for (const a of r.aliases) if (!byName.has(normTitle(a))) byName.set(normTitle(a), r.id);
  return byName;
}

/**
 * Re-index a page's [[links]] from its body. Every write of `bodyMd` calls this (upsert, patch,
 * restore, undo); a soft delete keeps the rows, which readers skip by joining live pages.
 */
export async function indexWikiLinks(db: Ctx['db'], pageId: string, bodyMd: string) {
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
}

/**
 * Index the links of pages written before the link index existed: pages (live or deleted) with no
 * wiki_links rows whose body contains `[[`. Runs at API startup; idempotent, and one query when
 * nothing is pending. Uses the shared JS parser so the index matches what the ops write (a SQL
 * regex port would differ on Unicode whitespace and case). Pages whose `[[` yields no link (e.g.
 * only inside code) stay without rows and are re-read on each run, which is harmless.
 * Returns how many pages got rows.
 */
export async function backfillWikiLinks(db: Db, batchSize = 200): Promise<number> {
  let after = '';
  let indexed = 0;
  for (;;) {
    const batch = await db.transaction(async (tx) => {
      // Re-checked inside the transaction (and locked), so a page an op indexes meanwhile is skipped.
      const rows = await tx
        .select({ id: pages.id, bodyMd: pages.bodyMd })
        .from(pages)
        .where(
          and(
            sql`${pages.id} > ${after}`,
            sql`${pages.bodyMd} like '%[[%'`,
            sql`not exists (select 1 from ${links} where ${links.fromPageId} = ${pages.id})`,
          ),
        )
        .orderBy(asc(pages.id))
        .limit(batchSize)
        .for('update');
      for (const r of rows) {
        await indexWikiLinks(tx, r.id, r.bodyMd);
        if (wikiLinkTargets(r.bodyMd).length) indexed++;
      }
      return rows;
    });
    if (batch.length < batchSize) return indexed;
    after = batch[batch.length - 1]!.id;
  }
}

/** The [[link]] targets of a body that name no live page of the show (as written). */
export async function unresolvedTargets(
  db: Ctx['db'],
  showId: string,
  bodyMd: string,
): Promise<string[]> {
  const targets = wikiLinkTargets(bodyMd);
  if (!targets.length) return [];
  const byName = await wikiNames(db, showId);
  return targets.filter((t) => !byName.has(normTitle(t)));
}

/** First paragraph of a body, skipping headings, capped at 400 characters. */
function firstParagraph(bodyMd: string): string {
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
  const where = and(live, eq(pages.showId, row.showId), linking);
  const backlinks = await ctx.db
    .select({ id: pages.id, title: pages.title, kind: pages.kind })
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
 * Condition on `pages` for the pages whose [[links]] resolve to `row` (itself excluded), from the
 * link index; undefined when no name resolves to it. Links resolve as in the renderer and
 * wiki.lint: by normTitle, titles winning over aliases — resolved here, at read time, so renames
 * and alias changes need no reindex.
 */
async function linkingTo(ctx: Ctx, row: PageRow): Promise<SQL | undefined> {
  const byName = await wikiNames(ctx.db, row.showId);
  const names = [...byName].filter(([, id]) => id === row.id).map(([n]) => n);
  if (!names.length) return undefined;
  return and(
    ne(pages.id, row.id),
    inArray(
      pages.id,
      ctx.db.select({ id: links.fromPageId }).from(links).where(inArray(links.targetNorm, names)),
    ),
  );
}

async function loadPage(ctx: Ctx, pageId: string, need: 'read' | 'write') {
  const [row] = await ctx.db
    .select()
    .from(pages)
    .where(and(eq(pages.id, pageId), live));
  if (!row) throw notFound('Wiki page');
  await requireShow(ctx, row.showId, need);
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

/** Find a live page by title or alias within a show, resolved like a [[link]] (normTitle). */
async function findByTitle(ctx: Ctx, showId: string, title: string): Promise<PageRow | undefined> {
  const id = (await wikiNames(ctx.db, showId)).get(normTitle(title));
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
    'Wiki pages of a show (people, topics, recurring bits, session recaps), sorted by kind then title, as { pages, total, nextOffset }. Paged: limit (default 50, max 200) and offset; when nextOffset is not null, call again with offset = nextOffset for the rest. Metadata only by default. Bulk read: include "summary" adds each page\'s first paragraph (headings skipped, max 400 chars); include "body" adds the full bodyMd of every page, which is large (pages run to several KB each) — narrow it with kind (e.g. kind "session" for all recaps) and a smaller limit. linksTo (a pageId of this show, from wiki_list / wiki_get) keeps only the pages whose [[links]] point to that page: its full backlinks list, of which wiki_get returns only the first 50 (backlinkCount has the total).',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { showId, kind, include, linksTo, limit = 50, offset = 0 }): Promise<WikiList> {
    await requireShow(ctx, showId, 'read');
    let linking: SQL | undefined;
    if (linksTo) {
      const target = await loadPage(ctx, linksTo, 'read');
      if (target.showId !== showId) throw badRequest('linksTo is a page of another show.');
      linking = await linkingTo(ctx, target);
      if (!linking) return { pages: [], total: 0, nextOffset: null };
    }
    const where = and(
      live,
      eq(pages.showId, showId),
      kind ? eq(pages.kind, kind) : undefined,
      linking,
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
    const list = await summaries(ctx, rows);
    const nextOffset = offset + rows.length < total ? offset + rows.length : null;
    if (include === 'body')
      return {
        pages: list.map((p, i) => ({ ...p, bodyMd: rows[i]!.bodyMd })),
        total,
        nextOffset,
      };
    if (include === 'summary')
      return {
        pages: list.map((p, i) => ({ ...p, summary: firstParagraph(rows[i]!.bodyMd) })),
        total,
        nextOffset,
      };
    return { pages: list, total, nextOffset };
  },
});

defineOp({
  name: 'wiki.lint',
  description:
    'Check the links of a whole show wiki in one call, the way the wiki renders them. unresolved: pages with [[Target]] / [[Target|label]] links (also [[Target\\|label]] in table cells; links inside code are ignored) that match no page title or alias (case-insensitive, spaces collapsed), with the missing targets as written — create those pages with wiki_upsert or fix the links. orphans: person, topic and bit pages no other page links to (session recaps are left out; they are reached from their session). counts: pages, distinct links, unresolved links, orphans. Read-only.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { showId }): Promise<WikiLint> {
    await requireShow(ctx, showId, 'read');
    const rows = await ctx.db
      .select({ id: pages.id, title: pages.title, kind: pages.kind })
      .from(pages)
      .where(and(live, eq(pages.showId, showId)))
      .orderBy(asc(pages.kind), asc(pages.title));
    const byName = await wikiNames(ctx.db, showId);
    // The link index of the show's live pages, in each body's order (no bodies are parsed).
    const targetsOf = new Map<string, { target: string; norm: string }[]>();
    for (const l of await ctx.db
      .select({ from: links.fromPageId, target: links.target, norm: links.targetNorm })
      .from(links)
      .innerJoin(pages, eq(pages.id, links.fromPageId))
      .where(and(live, eq(pages.showId, showId)))
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
    const orphans = rows
      .filter((r) => r.kind !== 'session' && !linked.has(r.id))
      .map((r) => ({ pageId: r.id, title: r.title, kind: r.kind }));
    return {
      unresolved,
      orphans,
      counts: { pages: rows.length, links: linkCount, unresolvedLinks, orphans: orphans.length },
    };
  },
});

defineOp({
  name: 'wiki.get',
  description:
    'Read a wiki page by pageId, or by showId + title (aliases match too; case and extra spaces are ignored, as in [[links]]). Includes backlinkCount and backlinks (the pages linking here, first 50 by title; when backlinkCount is larger, wiki_list with linksTo = this pageId pages through all of them). To read many pages in one call use wiki_list with include "summary" or "body".',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { pageId, showId, title }) {
    if (pageId) return fullPage(ctx, await loadPage(ctx, pageId, 'read'));
    if (!showId || !title) throw badRequest('Give pageId, or showId and title.');
    await requireShow(ctx, showId, 'read');
    const row = await findByTitle(ctx, showId, title);
    if (!row) throw notFound('Wiki page');
    return fullPage(ctx, row);
  },
});

defineOp({
  name: 'wiki.upsert',
  description:
    'Create or update a wiki page. Without pageId, a page with the same title (or alias) is updated (keeping its title), otherwise a new one is created; pass pageId to rename. bodyMd is raw Markdown text, stored exactly as sent: write real newlines and quotes, not JSON escapes like \\n or \\" inside the text. Link other pages with [[Title]] or [[Title|label]]; wiki_lint finds links to missing pages. Kind "session" pages are recaps tied to sessionId. Every save keeps a revision. To fix a few sentences of an existing page, use wiki_patch instead of resending the whole body. ' +
    'Returns the saved page with its body and backlinks; pass `compact: true` (recommended for agents) to get only `{ id, title, kind, revision, unresolvedLinks }`, where unresolvedLinks lists the [[link]] targets in the body that match no page title or alias in the show yet (create those pages, or fix the link; wiki_lint checks the whole wiki).',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, input) {
    await requireShow(ctx, input.showId, 'write');
    if (input.kind === 'session' && !input.sessionId)
      throw badRequest('Session pages need a sessionId.');
    if (input.sessionId) {
      const { session } = await requireSession(ctx, input.sessionId, 'read');
      if (session.showId !== input.showId)
        throw badRequest('That session belongs to another show.');
    }
    const existing = input.pageId
      ? await loadPage(ctx, input.pageId, 'write')
      : await findByTitle(ctx, input.showId, input.title);
    if (existing && existing.showId !== input.showId)
      throw badRequest('That page belongs to another show.');
    const clash = await findByTitle(ctx, input.showId, input.title);
    if (clash && clash.id !== existing?.id)
      throw conflict(`A page titled “${clash.title}” already exists.`);
    // Matched by title/alias (no pageId): keep the canonical title; renaming needs an explicit pageId.
    const title = existing && !input.pageId ? existing.title : input.title;
    const values = {
      kind: input.kind,
      title,
      titleNorm: normTitle(title),
      bodyMd: input.bodyMd,
      aliases: input.aliases ?? existing?.aliases ?? [],
      sessionId: input.sessionId ?? existing?.sessionId ?? null,
      updatedBy: ctx.actor.user.id,
      updatedAt: new Date(),
    };
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
        sessionId: row.sessionId,
        before: snapshot(existing),
        after: snapshot(row),
      });
    } else {
      [row] = (await ctx.db
        .insert(pages)
        .values({
          id: newId('wiki'),
          showId: input.showId,
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
        sessionId: row.sessionId,
        after: snapshot(row),
      });
    }
    await addRevision(ctx, row);
    await indexWikiLinks(ctx.db, row.id, row.bodyMd);
    if (input.compact)
      return {
        id: row.id,
        title: row.title,
        kind: row.kind,
        revision: row.revision,
        unresolvedLinks: await unresolvedTargets(ctx.db, row.showId, row.bodyMd),
      };
    return fullPage(ctx, row);
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
    'Fix part of a wiki page without resending its body. edits: [{ find, replace }] are exact, case-sensitive text replacements applied in order; each `find` must occur exactly once in the page at that point (otherwise bad_request saying how often it matched; include more surrounding text to make it unique), and nothing is saved unless every edit applies. append (optional) adds Markdown on a new line at the end. Saved as one new revision, undoable from the change log. pageId comes from wiki_list / wiki_get. Returns the page summary (id, title, revision) without the body; read it with wiki_get if needed.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { pageId, edits, append }) {
    const row = await loadPage(ctx, pageId, 'write');
    if (!edits.length && !append) throw badRequest('Give at least one edit or append.');
    let body = row.bodyMd;
    for (const [i, e] of edits.entries()) {
      const n = occurrences(body, e.find);
      if (n !== 1)
        throw badRequest(
          n === 0
            ? `edits[${i}].find was not found in the page (it must match exactly, including case and whitespace).`
            : `edits[${i}].find matches ${n} times; include more surrounding text so it matches once.`,
        );
      const at = body.indexOf(e.find);
      body = body.slice(0, at) + e.replace + body.slice(at + e.find.length);
    }
    if (append) body = body && !body.endsWith('\n') ? `${body}\n${append}` : body + append;
    if (body.length > 100_000) throw badRequest('The page would exceed 100000 characters.');
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
      sessionId: row.sessionId,
      before: snapshot(row),
      after: snapshot(after),
    });
    await addRevision(ctx, after);
    await indexWikiLinks(ctx.db, after.id, after.bodyMd);
    const [summary] = await summaries(ctx, [after]);
    return summary!;
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
    await indexWikiLinks(ctx.db, after.id, after.bodyMd);
    await ctx.record({
      entity: 'wiki_page',
      entityId: pageId,
      kind: 'update',
      summary: `Restored “${after.title}” to revision ${revision}`,
      showId: row.showId,
      sessionId: row.sessionId,
      before: snapshot(row),
      after: snapshot(after),
    });
    return fullPage(ctx, after);
  },
});
