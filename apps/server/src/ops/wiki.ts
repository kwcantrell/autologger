import type { WikiPage, WikiPageSummary } from '@autologger/contract';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { requireSession, requireShow } from '../core/authz.ts';
import { badRequest, conflict, notFound } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp, snapshot } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { iso, userRefs } from './map.ts';

const { wikiPages: pages, wikiRevisions: revisions } = schema;
type PageRow = typeof pages.$inferSelect;

export const normTitle = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');

async function summaries(ctx: Ctx, rows: PageRow[]): Promise<WikiPageSummary[]> {
  const users = await userRefs(ctx.db, rows.map((r) => r.updatedBy));
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

async function fullPage(ctx: Ctx, row: PageRow): Promise<WikiPage> {
  const [summary] = await summaries(ctx, [row]);
  const names = [row.title, ...row.aliases].map((n) => `%[[${n.replace(/[%_]/g, '\\$&')}]]%`);
  const backlinks = await ctx.db
    .select({ id: pages.id, title: pages.title, kind: pages.kind })
    .from(pages)
    .where(and(eq(pages.showId, row.showId), sql`${pages.id} <> ${row.id}`, sql`${pages.bodyMd} ilike any(array[${sql.join(names.map((n) => sql`${n}`), sql`, `)}]::text[])`))
    .orderBy(asc(pages.title));
  return { ...summary!, bodyMd: row.bodyMd, backlinks };
}

async function loadPage(ctx: Ctx, pageId: string, need: 'read' | 'write') {
  const [row] = await ctx.db.select().from(pages).where(eq(pages.id, pageId));
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

/** Find an existing page by title or alias (case-insensitive) within a show. */
async function findByTitle(ctx: Ctx, showId: string, title: string): Promise<PageRow | undefined> {
  const n = normTitle(title);
  const [row] = await ctx.db
    .select()
    .from(pages)
    .where(
      and(
        eq(pages.showId, showId),
        sql`(${pages.titleNorm} = ${n} or exists (select 1 from jsonb_array_elements_text(${pages.aliases}) a where lower(a) = ${n}))`,
      ),
    );
  return row;
}

defineOp({
  name: 'wiki.list',
  description: 'Wiki pages of a show (people, topics, recurring bits, session recaps).',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { showId, kind }) {
    await requireShow(ctx, showId, 'read');
    const rows = await ctx.db
      .select()
      .from(pages)
      .where(and(eq(pages.showId, showId), kind ? eq(pages.kind, kind) : undefined))
      .orderBy(asc(pages.kind), asc(pages.title));
    return summaries(ctx, rows);
  },
});

defineOp({
  name: 'wiki.get',
  description: 'Read a wiki page by pageId, or by showId + title (aliases match too). Includes backlinks.',
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
    'Create or update a wiki page. Without pageId, a page with the same title (or alias) is updated, otherwise a new one is created. Body is Markdown; link other pages with [[Title]]. Kind "session" pages are recaps tied to sessionId. Every save keeps a revision.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, input) {
    await requireShow(ctx, input.showId, 'write');
    if (input.kind === 'session' && !input.sessionId) throw badRequest('Session pages need a sessionId.');
    if (input.sessionId) {
      const { session } = await requireSession(ctx, input.sessionId, 'read');
      if (session.showId !== input.showId) throw badRequest('That session belongs to another show.');
    }
    const existing = input.pageId ? await loadPage(ctx, input.pageId, 'write') : await findByTitle(ctx, input.showId, input.title);
    if (existing && existing.showId !== input.showId) throw badRequest('That page belongs to another show.');
    const clash = await findByTitle(ctx, input.showId, input.title);
    if (clash && clash.id !== existing?.id) throw conflict(`A page titled “${clash.title}” already exists.`);
    const values = {
      kind: input.kind,
      title: input.title,
      titleNorm: normTitle(input.title),
      bodyMd: input.bodyMd,
      aliases: input.aliases ?? existing?.aliases ?? [],
      sessionId: input.sessionId ?? existing?.sessionId ?? null,
      updatedBy: ctx.actor.user.id,
      updatedAt: new Date(),
    };
    let row: PageRow;
    if (existing) {
      [row] = (await ctx.db.update(pages).set({ ...values, revision: existing.revision + 1 }).where(eq(pages.id, existing.id)).returning()) as [PageRow];
      await ctx.record({ entity: 'wiki_page', entityId: row.id, kind: 'update', summary: `Edited wiki page “${row.title}”`, showId: row.showId, sessionId: row.sessionId, before: snapshot(existing), after: snapshot(row) });
    } else {
      [row] = (await ctx.db.insert(pages).values({ id: newId('wiki'), showId: input.showId, ...values, createdBy: ctx.actor.user.id }).returning()) as [PageRow];
      await ctx.record({ entity: 'wiki_page', entityId: row.id, kind: 'create', summary: `Created wiki page “${row.title}”`, showId: row.showId, sessionId: row.sessionId, after: snapshot(row) });
    }
    await addRevision(ctx, row);
    return fullPage(ctx, row);
  },
});

defineOp({
  name: 'wiki.delete',
  description: 'Delete a wiki page.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { pageId }) {
    const row = await loadPage(ctx, pageId, 'write');
    await ctx.record({ entity: 'wiki_page', entityId: row.id, kind: 'delete', summary: `Deleted wiki page “${row.title}”`, showId: row.showId, sessionId: row.sessionId, before: snapshot(row) });
    await ctx.db.delete(pages).where(eq(pages.id, pageId));
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
    const rows = await ctx.db.select().from(revisions).where(eq(revisions.pageId, pageId)).orderBy(desc(revisions.revision));
    const users = await userRefs(ctx.db, rows.map((r) => r.authorId));
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
    const [rev] = await ctx.db.select().from(revisions).where(and(eq(revisions.pageId, pageId), eq(revisions.revision, revision)));
    if (!rev) throw notFound('Revision');
    const [after] = (await ctx.db
      .update(pages)
      .set({ title: rev.title, titleNorm: normTitle(rev.title), bodyMd: rev.bodyMd, aliases: rev.aliases, revision: row.revision + 1, updatedBy: ctx.actor.user.id, updatedAt: new Date() })
      .where(eq(pages.id, pageId))
      .returning()) as [PageRow];
    await addRevision(ctx, after);
    await ctx.record({ entity: 'wiki_page', entityId: pageId, kind: 'update', summary: `Restored “${after.title}” to revision ${revision}`, showId: row.showId, sessionId: row.sessionId, before: snapshot(row), after: snapshot(after) });
    return fullPage(ctx, after);
  },
});
