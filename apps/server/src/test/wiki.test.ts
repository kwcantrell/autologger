import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
