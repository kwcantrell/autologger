import { normTitle, wikiLinkTargets } from '@autologger/contract';
import { asc, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../core/op.ts';
import { db, schema } from '../db/client.ts';
import { backfillWikiLinks, wikiNames } from '../ops/wiki.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

async function pageWithHistory() {
  const fx = await studio();
  const { owner, show } = fx;
  const page = await call(owner, 'wiki.upsert', {
    showId: show.id,
    kind: 'person',
    title: 'Dana',
    bodyMd: 'Host.',
  });
  await call(owner, 'wiki.upsert', {
    showId: show.id,
    kind: 'person',
    title: 'Dana',
    bodyMd: 'Host of the show.',
  });
  await call(owner, 'wiki.upsert', {
    showId: show.id,
    kind: 'bit',
    title: 'Cold open',
    bodyMd: 'With [[Dana]].',
  });
  return { ...fx, page };
}

describe('wiki delete keeps history', () => {
  it('hides a deleted page everywhere and undo brings it back with every revision', async () => {
    const { owner, show, page } = await pageWithHistory();
    await call(owner, 'wiki.delete', { pageId: page.id });

    expect((await call(owner, 'wiki.list', { showId: show.id })).pages.map((p) => p.title)).toEqual(
      ['Cold open'],
    );
    await failsWith(call(owner, 'wiki.get', { pageId: page.id }), 'not_found');
    await failsWith(call(owner, 'wiki.get', { showId: show.id, title: 'Dana' }), 'not_found');
    await failsWith(call(owner, 'wiki.revisions', { pageId: page.id }), 'not_found');
    expect(await call(owner, 'search', { query: 'host', kinds: ['wiki'] })).toEqual([]);

    const [del] = await call(owner, 'changes.list', { showId: show.id });
    expect(del).toMatchObject({ kind: 'delete', entityId: page.id });
    await call(owner, 'changes.revert', { changeId: del!.id });

    const restored = await call(owner, 'wiki.get', { pageId: page.id });
    expect(restored).toMatchObject({ title: 'Dana', bodyMd: 'Host of the show.', revision: 2 });
    expect(restored.backlinks.map((b) => b.title)).toEqual(['Cold open']);
    expect(
      (await call(owner, 'wiki.revisions', { pageId: page.id })).map((r) => r.revision),
    ).toEqual([2, 1]);
  });

  it('frees the title of a deleted page, and refuses to restore over a page that reused it', async () => {
    const { owner, show, page } = await pageWithHistory();
    await call(owner, 'wiki.delete', { pageId: page.id });
    const [del] = await call(owner, 'changes.list', { showId: show.id });

    const reused = await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'person',
      title: 'Dana',
      bodyMd: 'Someone new.',
    });
    expect(reused.id).not.toBe(page.id);
    expect(reused.revision).toBe(1);

    await failsWith(call(owner, 'changes.revert', { changeId: del!.id }), 'conflict');
    // The failed undo changed nothing.
    expect((await call(owner, 'wiki.get', { showId: show.id, title: 'Dana' })).id).toBe(reused.id);
  });

  it('undoing an agent-created page hides it, and redo brings it back with its revision', async () => {
    const { owner, show } = await studio();
    const agent = asAgent(owner, 'Claude Code');
    const page = await call(agent, 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Recap',
      bodyMd: 'Draft.',
    });
    const [created] = await call(owner, 'changes.list', { showId: show.id, via: 'mcp' });

    const undo = await call(owner, 'changes.revert', { changeId: created!.id });
    await failsWith(call(owner, 'wiki.get', { pageId: page.id }), 'not_found');

    await call(owner, 'changes.revert', { changeId: undo.id });
    expect((await call(owner, 'wiki.get', { pageId: page.id })).bodyMd).toBe('Draft.');
    expect(await call(owner, 'wiki.revisions', { pageId: page.id })).toHaveLength(1);
  });
});

describe('wiki lint and bulk read', () => {
  it('lints links the way the wiki renders them', async () => {
    const { owner, team, show, session } = await pageWithHistory();
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'person',
      title: 'Mark Manson',
      aliases: ['Mark'],
      bodyMd: 'Guest.',
    });
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Guide',
      bodyMd: [
        '# Guide',
        '',
        'Hosted by [[ dana ]], with [[MARK]] and [[Missing]] twice: [[missing|again]].',
        '',
        '| Ep | Guest |',
        '| -- | ----- |',
        '| 1 | [[Mark   Manson\\|Mark]] |',
        '| 2 | [[Table Gap\\|someone]] |',
        '',
        'Literal `[[Not A Link]]` and:',
        '```',
        '[[Fenced]]',
        '```',
      ].join('\n'),
    });
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'session',
      title: 'Ep 1 recap',
      bodyMd: 'With [[Guide]].',
      sessionId: session.id,
    });

    // A read-only member can lint.
    const viewer = await makeUser('viewer@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: 'viewer@example.com' });
    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: viewer.user.id,
      showId: show.id,
      access: 'read',
    });
    const lint = await call(viewer, 'wiki.lint', { showId: show.id });
    expect(lint.unresolved).toEqual([
      expect.objectContaining({ title: 'Guide', targets: ['Missing', 'Table Gap'] }),
    ]);
    // Nothing links to Cold open; session recaps are never orphans.
    expect(lint.orphans.map((o) => o.title)).toEqual(['Cold open']);
    expect(lint.counts).toEqual({ pages: 5, links: 7, unresolvedLinks: 2, orphans: 1 });

    const stranger = await makeUser('stranger@example.com');
    await failsWith(call(stranger, 'wiki.lint', { showId: show.id }), 'not_found');
  });

  it('finds backlinks and titles the way links resolve', async () => {
    const { owner, team, show } = await pageWithHistory();
    const mark = await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'person',
      title: 'Mark Manson',
      aliases: ['Marky  Mark'],
      bodyMd: 'Guest.',
    });
    const link = (title: string, bodyMd: string) =>
      call(owner, 'wiki.upsert', { showId: show.id, kind: 'topic', title, bodyMd });
    await link('Code only', 'Literal `[[Mark Manson]]` and\n```\n[[Mark Manson]]\n```');
    await link('Table', '| Ep | Guest |\n| -- | -- |\n| 1 | [[Mark   manson\\|Mark]] |');
    await link('Alias', 'Hi [[ marky mark ]].');
    await link('Mentions', 'Mark Manson, no [[link]].');

    const viewer = await makeUser('viewer@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: 'viewer@example.com' });
    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: viewer.user.id,
      showId: show.id,
      access: 'read',
    });
    // An alias with double spaces resolves by normTitle, like a [[link]].
    const page = await call(viewer, 'wiki.get', { showId: show.id, title: 'MARKY mark' });
    expect(page.id).toBe(mark.id);
    expect(page.backlinks.map((b) => b.title)).toEqual(['Alias', 'Table']);
    expect(page.backlinkCount).toBe(2);

    const stranger = await makeUser('stranger@example.com');
    await failsWith(call(stranger, 'wiki.get', { pageId: mark.id }), 'not_found');
  });

  it('lists pages in pages with summaries or bodies', async () => {
    const { owner, team, show } = await pageWithHistory();
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Guide',
      bodyMd: '# Guide\n\nFirst  paragraph\nwraps.\n\nSecond.',
    });

    const first = await call(owner, 'wiki.list', { showId: show.id, include: 'summary', limit: 2 });
    expect(first.total).toBe(3);
    expect(first.nextOffset).toBe(2);
    expect(first.pages).toHaveLength(2);
    expect(first.pages[0]).not.toHaveProperty('bodyMd');
    const [guide] = (
      await call(owner, 'wiki.list', { showId: show.id, kind: 'topic', include: 'summary' })
    ).pages;
    expect(guide).toMatchObject({ title: 'Guide', summary: 'First  paragraph wraps.' });
    const rest = await call(owner, 'wiki.list', { showId: show.id, limit: 2, offset: 2 });
    expect(rest).toMatchObject({ total: 3, nextOffset: null });
    expect(rest.pages[0]).not.toHaveProperty('bodyMd');

    const viewer = await makeUser('viewer@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: 'viewer@example.com' });
    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: viewer.user.id,
      showId: show.id,
      access: 'read',
    });
    const bodies = await call(viewer, 'wiki.list', {
      showId: show.id,
      kind: 'person',
      include: 'body',
    });
    expect(bodies.pages).toEqual([
      expect.objectContaining({ title: 'Dana', bodyMd: 'Host of the show.' }),
    ]);

    const stranger = await makeUser('stranger@example.com');
    await failsWith(call(stranger, 'wiki.list', { showId: show.id, include: 'body' }), 'not_found');
  });

  it('pages through every backlink with wiki.list linksTo', async () => {
    const { owner, team, show, page: dana } = await pageWithHistory();
    // 55 topics link to Dana (as written differently), 5 only mention her; plus the Cold open bit.
    for (let i = 0; i < 60; i++)
      await call(owner, 'wiki.upsert', {
        showId: show.id,
        kind: 'topic',
        title: `Topic ${String(i).padStart(2, '0')}`,
        bodyMd: i % 12 === 11 ? 'Dana, no link.' : 'With [[ dana ]].',
      });

    const got = await call(owner, 'wiki.get', { pageId: dana.id });
    expect(got).toMatchObject({ backlinkCount: 56 });
    expect(got.backlinks).toHaveLength(50);
    const first = await call(owner, 'wiki.list', { showId: show.id, linksTo: dana.id, limit: 50 });
    expect(first).toMatchObject({ total: 56, nextOffset: 50 });
    expect(first.pages[0]).toMatchObject({ title: 'Cold open', kind: 'bit' });
    const rest = await call(owner, 'wiki.list', {
      showId: show.id,
      linksTo: dana.id,
      limit: 50,
      offset: 50,
    });
    expect(rest).toMatchObject({ total: 56, nextOffset: null });
    expect(rest.pages.map((p) => p.title)).toEqual([
      'Topic 53',
      'Topic 54',
      'Topic 55',
      'Topic 56',
      'Topic 57',
      'Topic 58',
    ]);
    const bits = await call(owner, 'wiki.list', { showId: show.id, linksTo: dana.id, kind: 'bit' });
    expect(bits.total).toBe(1);

    const other = await call(owner, 'shows.create', { teamId: team.id, name: 'Other' });
    await failsWith(
      call(owner, 'wiki.list', { showId: other.id, linksTo: dana.id }),
      'bad_request',
    );
    const stranger = await makeUser('stranger@example.com');
    await failsWith(
      call(stranger, 'wiki.list', { showId: show.id, linksTo: dana.id }),
      'not_found',
    );
  });
});

describe('wiki link index', () => {
  const backlinks = async (actor: Actor, pageId: string) =>
    (await call(actor, 'wiki.get', { pageId })).backlinks.map((b) => b.title);
  const undoLatest = async (actor: Actor, showId: string) => {
    const [latest] = await call(actor, 'changes.list', { showId });
    await call(actor, 'changes.revert', { changeId: latest!.id });
  };

  it('follows upsert, patch, restore, delete, undo and renames', async () => {
    const { owner, show, page: dana } = await pageWithHistory();
    const cold = await call(owner, 'wiki.get', { showId: show.id, title: 'Cold open' });
    expect(await backlinks(owner, dana.id)).toEqual(['Cold open']);

    await call(owner, 'wiki.patch', {
      pageId: cold.id,
      edits: [{ find: '[[Dana]]', replace: '[[Sam]]' }],
    });
    expect(await backlinks(owner, dana.id)).toEqual([]);
    expect((await call(owner, 'wiki.lint', { showId: show.id })).unresolved).toEqual([
      expect.objectContaining({ title: 'Cold open', targets: ['Sam'] }),
    ]);
    await undoLatest(owner, show.id);
    expect(await backlinks(owner, dana.id)).toEqual(['Cold open']);

    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'bit',
      title: 'Cold open',
      bodyMd: 'Nobody.',
    });
    expect(await backlinks(owner, dana.id)).toEqual([]);
    await call(owner, 'wiki.restore', { pageId: cold.id, revision: 1 });
    expect(await backlinks(owner, dana.id)).toEqual(['Cold open']);

    await call(owner, 'wiki.delete', { pageId: cold.id });
    expect((await call(owner, 'wiki.get', { pageId: dana.id })).backlinkCount).toBe(0);
    expect((await call(owner, 'wiki.lint', { showId: show.id })).orphans).toEqual([
      expect.objectContaining({ title: 'Dana' }),
    ]);
    await undoLatest(owner, show.id);
    expect(await backlinks(owner, dana.id)).toEqual(['Cold open']);

    // Links resolve at read time: a rename keeps them only through an alias.
    const rename = (aliases: string[]) =>
      call(owner, 'wiki.upsert', {
        showId: show.id,
        pageId: dana.id,
        kind: 'person',
        title: 'Dana Smith',
        aliases,
        bodyMd: 'Host of the show.',
      });
    await rename(['dana']);
    expect(await backlinks(owner, dana.id)).toEqual(['Cold open']);
    await rename([]);
    expect(await backlinks(owner, dana.id)).toEqual([]);
    expect((await call(owner, 'wiki.lint', { showId: show.id })).unresolved).toEqual([
      expect.objectContaining({ title: 'Cold open', targets: ['Dana'] }),
    ]);
    await undoLatest(owner, show.id);
    expect(await backlinks(owner, dana.id)).toEqual(['Cold open']);

    // Undo and redo of an agent-created page drop and bring back its links.
    await call(asAgent(owner), 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Recap',
      bodyMd: 'See [[Dana]].',
    });
    expect(await backlinks(owner, dana.id)).toEqual(['Cold open', 'Recap']);
    const [created] = await call(owner, 'changes.list', { showId: show.id, via: 'mcp' });
    const undo = await call(owner, 'changes.revert', { changeId: created!.id });
    expect(await backlinks(owner, dana.id)).toEqual(['Cold open']);
    await call(owner, 'changes.revert', { changeId: undo.id });
    expect(await backlinks(owner, dana.id)).toEqual(['Cold open', 'Recap']);

    const stranger = await makeUser('stranger@example.com');
    await failsWith(
      call(stranger, 'wiki.patch', { pageId: cold.id, append: '[[Sam]]' }),
      'not_found',
    );
  });

  it('backfills existing pages exactly as the old body scan resolved links', async () => {
    const { owner, show } = await studio();
    const page = (
      kind: 'person' | 'topic' | 'bit',
      title: string,
      bodyMd: string,
      aliases?: string[],
    ) => call(owner, 'wiki.upsert', { showId: show.id, kind, title, bodyMd, aliases });
    await page('person', 'Mark Manson', 'Guest. Self link [[Mark Manson]].', ['Marky  Mark']);
    await page('person', 'Dana', 'Host, often with [[MARK manson]].', ['Mark']);
    await page(
      'topic',
      'Guide',
      [
        'Hosted by [[ dana ]], with [[MARK]], [[Missing]] and [[missing|again]].',
        '| Ep | Guest |',
        '| -- | ----- |',
        '| 1 | [[Mark   Manson\\|Mark]] |',
        '| 2 | [[Table Gap\\|someone]] |',
        'Literal `[[Not A Link]]`, ``[[Also `not` one]]`` and:',
        '```js',
        '[[Fenced]]',
        '```',
        '~~~~',
        '[[Tilde fenced]]',
        '~~~~',
        'After [[ marky mark ]].',
      ].join('\n'),
    );
    await page('bit', 'Cold open', 'No links, just Dana.');
    await page('topic', 'Unclosed', 'Before [[Dana]].\n```\n[[Guide]] never closed');
    // Unicode: JS whitespace (NBSP, U+FEFF) and case folding beyond ASCII.
    await page('person', 'José Andrés', 'Chef.', ['Ünïcode']);
    await page(
      'topic',
      'Food',
      'With [[JOSÉ\u00a0andrés]], [[\ufeffünÏcode]] and [[ÉTÉ\u00a0\u00a0Menu]].',
    );

    const rows = async () =>
      (
        await db
          .select()
          .from(schema.wikiLinks)
          .orderBy(asc(schema.wikiLinks.fromPageId), asc(schema.wikiLinks.ord))
      ).map(({ fromPageId, target, targetNorm }) => ({ fromPageId, target, targetNorm }));
    const indexed = await rows();
    const read = async () => {
      const { pages } = await call(owner, 'wiki.list', { showId: show.id });
      const out: Record<string, unknown> = {
        lint: await call(owner, 'wiki.lint', { showId: show.id }),
      };
      for (const p of pages) {
        const got = await call(owner, 'wiki.get', { pageId: p.id });
        const linksTo = await call(owner, 'wiki.list', { showId: show.id, linksTo: p.id });
        out[p.title] = [got.backlinks.map((b) => b.title), got.backlinkCount, linksTo.total];
      }
      return out;
    };
    const before = await read();

    // The old way: parse every live body and resolve each target through titles and aliases.
    const all = await db
      .select()
      .from(schema.wikiPages)
      .where(eq(schema.wikiPages.showId, show.id));
    const byName = await db.transaction((tx) => wikiNames(tx, show.id));
    for (const p of all) {
      const linking = all
        .filter((o) => o.id !== p.id)
        .filter((o) => wikiLinkTargets(o.bodyMd).some((t) => byName.get(normTitle(t)) === p.id))
        .map((o) => o.title)
        .sort();
      expect(before[p.title]).toEqual([linking, linking.length, linking.length]);
    }
    expect(before['Mark Manson']).toEqual([['Dana', 'Guide'], 2, 2]);
    expect(before['José Andrés']).toEqual([['Food'], 1, 1]);
    expect((before.lint as { unresolved: unknown }).unresolved).toEqual([
      expect.objectContaining({ title: 'Food', targets: ['ÉTÉ\u00a0\u00a0Menu'] }),
      expect.objectContaining({ title: 'Guide', targets: ['Missing', 'Table Gap'] }),
    ]);

    // Pages saved before the index have no link rows: the startup backfill (in batches) rebuilds
    // exactly what the ops wrote, and a rerun is a no-op.
    await db.delete(schema.wikiLinks);
    expect(await backfillWikiLinks(db, 2)).toBe(5);
    expect(await backfillWikiLinks(db, 2)).toBe(0);
    expect(await rows()).toEqual(indexed);
    expect(await read()).toEqual(before);
  });
});
