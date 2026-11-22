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
    expect(lint.counts).toEqual({
      pages: 5,
      links: 7,
      unresolvedLinks: 2,
      orphans: 1,
      citations: 0,
      badCitations: 0,
    });

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

describe('question pages and citations', () => {
  it('stores a cited answer and lints citations against the show sessions', async () => {
    const { owner, team, show, session } = await studio();
    await db.insert(schema.audioSegments).values({
      id: 'aud_cite',
      sessionId: session.id,
      ordinal: 0,
      startSec: 0,
      durationSec: 600,
      mimeType: 'audio/mpeg',
      origin: 'file',
      objectKey: 'test/aud_cite',
      status: 'ready',
    });
    const silent = await call(owner, 'sessions.create', { showId: show.id });
    const other = await call(owner, 'shows.create', { teamId: team.id, name: 'Other' });
    const elsewhere = await call(owner, 'sessions.create', { showId: other.id });
    const cite = (id: string, q: string) => `[x](/sessions/${id}?${q})`;
    const agent = asAgent(owner);
    const page = await call(agent, 'wiki.upsert', {
      showId: show.id,
      kind: 'question',
      title: 'When did Dana mention the dog?',
      bodyMd: [
        `Twice: ${cite(session.id, 't=10&to=20')} and ${cite(silent.id, 't=5000')}.`,
        `Wrong: ${cite(session.id, 't=550&to=700')} ${cite(session.id, 't=30&to=30')}`,
        `${cite(elsewhere.id, 't=1&to=2')} ${cite('ses_gone', 't=1')}`,
        `\`${cite('ses_code', 't=1')}\``,
      ].join('\n'),
      compact: true,
    });
    expect(page.kind).toBe('question');

    const lint = await call(owner, 'wiki.lint', { showId: show.id });
    // The save reports the same bad citations wiki.lint finds, for that page only.
    expect(page).toMatchObject({
      citationCount: 6,
      badCitations: lint.badCitations[0]!.citations,
    });
    expect(lint.badCitations).toEqual([
      {
        pageId: page.id,
        title: 'When did Dana mention the dog?',
        kind: 'question',
        citations: [
          { sessionId: session.id, startSec: 550, endSec: 700, label: 'x', problem: 'past_end' },
          { sessionId: session.id, startSec: 30, endSec: 30, label: 'x', problem: 'bad_range' },
          {
            sessionId: elsewhere.id,
            startSec: 1,
            endSec: 2,
            label: 'x',
            problem: 'unknown_session',
          },
          { sessionId: 'ses_gone', startSec: 1, label: 'x', problem: 'unknown_session' },
        ],
      },
    ]);
    // Question pages are reached from the Questions list, never orphans.
    expect(lint.orphans).toEqual([]);
    expect(lint.counts).toMatchObject({ pages: 1, citations: 6, badCitations: 4 });
    const listed = await call(owner, 'wiki.list', { showId: show.id, kind: 'question' });
    expect(listed.pages.map((p) => p.title)).toEqual(['When did Dana mention the dog?']);

    const stranger = await makeUser('stranger@example.com');
    await failsWith(
      call(stranger, 'wiki.upsert', { showId: show.id, kind: 'question', title: 'Q', bodyMd: '' }),
      'not_found',
    );

    const [created] = await call(owner, 'changes.list', { showId: show.id, via: 'mcp' });
    await call(owner, 'changes.revert', { changeId: created!.id });
    expect((await call(owner, 'wiki.lint', { showId: show.id })).counts.citations).toBe(0);
  });

  it('clamps a citation end slightly past the audio on save and keeps larger overshoots', async () => {
    const { owner, show, session } = await studio();
    await db.insert(schema.audioSegments).values({
      id: 'aud_clamp',
      sessionId: session.id,
      ordinal: 0,
      startSec: 0,
      durationSec: 6184.832,
      mimeType: 'audio/mpeg',
      origin: 'file',
      objectKey: 'test/aud_clamp',
      status: 'ready',
    });
    const cite = (q: string) => `[x](/sessions/${session.id}?${q})`;
    const agent = asAgent(owner);
    const page = await call(agent, 'wiki.upsert', {
      showId: show.id,
      kind: 'session',
      sessionId: session.id,
      title: 'Ep 3 recap',
      bodyMd: `${cite('t=6100&to=6185')} ${cite('t=6100&to=6200')} ${cite('t=6100&to=6184.5')}`,
    });
    const saved = `${cite('t=6100&to=6184.8')} ${cite('t=6100&to=6200')} ${cite('t=6100&to=6184.5')}`;
    expect(page.bodyMd).toBe(saved);
    const lint = await call(owner, 'wiki.lint', { showId: show.id });
    expect(lint.badCitations[0]!.citations).toEqual([
      { sessionId: session.id, startSec: 6100, endSec: 6200, label: 'x', problem: 'past_end' },
    ]);

    await call(agent, 'wiki.patch', { pageId: page.id, append: cite('t=10&to=6189') });
    const patched = await call(owner, 'wiki.get', { pageId: page.id });
    expect(patched.bodyMd).toBe(`${saved}\n${cite('t=10&to=6184.8')}`);
    const [latest] = await call(owner, 'changes.list', { showId: show.id, via: 'mcp' });
    await call(owner, 'changes.revert', { changeId: latest!.id });
    expect((await call(owner, 'wiki.get', { pageId: page.id })).bodyMd).toBe(saved);
    await failsWith(
      call(await makeUser('stranger@example.com'), 'wiki.patch', { pageId: page.id, append: 'x' }),
      'not_found',
    );
  });

  it('reports citation count and timecode labels that do not match the range on save', async () => {
    const { owner, show, session } = await studio();
    const cite = (label: string, q: string) => `[${label}](/sessions/${session.id}?${q})`;
    const page = await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'session',
      sessionId: session.id,
      title: 'Ep 13 recap',
      bodyMd: [
        cite('01:01:01', 't=3661.5&to=3700'),
        cite('1:01:01–1:01:40 the dog', 't=3661&to=3700.9'),
        cite('61:01', 't=3661'),
        cite('Tom on pricing at 00:01:01', 't=3661'),
        cite('00:01:01', 't=3661.5&to=3700'),
        cite('\\[01:01:01–01:02:00\\]', 't=3661&to=3700'),
      ].join('\n'),
    });
    const wrong = [
      { sessionId: session.id, startSec: 3661.5, endSec: 3700, label: '00:01:01' },
      { sessionId: session.id, startSec: 3661, endSec: 3700, label: '[01:01:01–01:02:00]' },
    ].map((c) => ({ ...c, problem: 'label_mismatch' }));
    expect(page).toMatchObject({ citationCount: 6, badCitations: wrong, backlinkCount: 0 });
    expect((await call(owner, 'wiki.lint', { showId: show.id })).badCitations).toEqual([
      expect.objectContaining({ pageId: page.id, citations: wrong }),
    ]);

    const fixed = await call(asAgent(owner), 'wiki.patch', {
      pageId: page.id,
      edits: [
        { find: '[00:01:01]', replace: '[01:01:01]' },
        { find: '01:02:00\\]', replace: '01:01:40\\]' },
      ],
    });
    expect(fixed).toMatchObject({ revision: 2, citationCount: 6, badCitations: [] });
    await failsWith(
      call(await makeUser('stranger@example.com'), 'wiki.patch', { pageId: page.id, append: 'x' }),
      'not_found',
    );
  });

  it('lists the pages citing a session, kept in step with every write, undo and the backfill', async () => {
    const { owner, team, show, session } = await studio();
    const other = await call(owner, 'sessions.create', { showId: show.id });
    const cite = (id: string, q: string) => `[x](/sessions/${id}?${q})`;
    const citing = async () =>
      (await call(owner, 'wiki.list', { showId: show.id, citesSession: session.id })).pages.map(
        (p) => [p.title, p.citations],
      );
    const q = await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'question',
      title: 'Q',
      bodyMd: `${cite(session.id, 't=10&to=20')} ${cite(other.id, 't=1')} ${cite(session.id, 't=30')}`,
    });
    const recap = await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'session',
      title: 'Recap',
      sessionId: other.id,
      bodyMd: `Only ${cite(other.id, 't=5')}`,
    });
    expect(await citing()).toEqual([
      [
        'Q',
        [
          { startSec: 10, endSec: 20, label: 'x' },
          { startSec: 30, label: 'x' },
        ],
      ],
    ]);

    // patch adds a citing page; delete hides one; undo brings it back.
    await call(owner, 'wiki.patch', { pageId: recap.id, append: cite(session.id, 't=42&to=50') });
    expect((await citing()).map(([t]) => t)).toEqual(['Q', 'Recap']);
    await call(owner, 'wiki.patch', {
      pageId: q.id,
      edits: [{ find: `${cite(session.id, 't=30')}`, replace: 'gone' }],
    });
    expect((await citing()).find(([t]) => t === 'Q')?.[1]).toEqual([
      { startSec: 10, endSec: 20, label: 'x' },
    ]);
    await call(owner, 'wiki.delete', { pageId: q.id });
    expect((await citing()).map(([t]) => t)).toEqual(['Recap']);
    const [del, patch] = await call(owner, 'changes.list', { showId: show.id });
    await call(owner, 'changes.revert', { changeId: del!.id });
    // Undoing the patch of Q restores its second citation.
    await call(owner, 'changes.revert', { changeId: patch!.id });
    const before = await citing();
    expect(before).toEqual([
      [
        'Q',
        [
          { startSec: 10, endSec: 20, label: 'x' },
          { startSec: 30, label: 'x' },
        ],
      ],
      ['Recap', [{ startSec: 42, endSec: 50, label: 'x' }]],
    ]);

    // countOnly: per-page counts and the total over every matching page, without the ranges.
    const counted = await call(owner, 'wiki.list', {
      showId: show.id,
      citesSession: session.id,
      countOnly: true,
      limit: 1,
    });
    expect(counted.pages.map((p) => [p.title, p.citationCount, p.citations])).toEqual([
      ['Q', 2, undefined],
    ]);
    expect([counted.total, counted.citationTotal]).toEqual([2, 3]);
    await failsWith(call(owner, 'wiki.list', { showId: show.id, countOnly: true }), 'bad_request');

    // Pages saved before the index: the backfill rebuilds it, and a rerun is a no-op.
    await db.delete(schema.wikiCitations);
    expect(await citing()).toEqual([]);
    expect(await backfillWikiLinks(db)).toBe(2);
    expect(await backfillWikiLinks(db)).toBe(0);
    expect(await citing()).toEqual(before);
    expect((await call(owner, 'wiki.lint', { showId: show.id })).counts.citations).toBe(5);

    // Another show's session is refused; a stranger cannot read the show or the session.
    const elsewhere = await call(owner, 'sessions.create', {
      showId: (await call(owner, 'shows.create', { teamId: team.id, name: 'Other' })).id,
    });
    await failsWith(
      call(owner, 'wiki.list', { showId: show.id, citesSession: elsewhere.id }),
      'bad_request',
    );
    const stranger = await makeUser('stranger@example.com');
    await failsWith(
      call(stranger, 'wiki.list', { showId: show.id, citesSession: session.id }),
      'not_found',
    );
  });
});
