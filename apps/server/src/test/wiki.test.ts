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

    expect((await call(owner, 'wiki.list', { showId: show.id })).map((p) => p.title)).toEqual([
      'Cold open',
    ]);
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
  it('finds unresolved links and orphans, and lists pages with summaries or bodies', async () => {
    const { owner, show } = await pageWithHistory();
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Guide',
      bodyMd:
        '# Guide\n\nHosted by [[dana]], see [[Cold open|the opener]].\n\nAlso [[Missing]] and [[Missing]].',
    });

    const lint = await call(owner, 'wiki.lint', { showId: show.id });
    expect(lint.unresolved).toEqual([
      expect.objectContaining({ title: 'Guide', targets: ['Missing'] }),
    ]);
    expect(lint.orphans.map((o) => o.title)).toEqual(['Guide']);
    expect(lint.counts).toEqual({ pages: 3, links: 4, unresolvedLinks: 1, orphans: 1 });

    const summaries = await call(owner, 'wiki.list', { showId: show.id, include: 'summary' });
    expect(summaries.find((p) => p.title === 'Guide')).toMatchObject({
      summary: 'Hosted by [[dana]], see [[Cold open|the opener]].',
    });
    expect(summaries[0]).not.toHaveProperty('bodyMd');
    const bodies = await call(owner, 'wiki.list', {
      showId: show.id,
      kind: 'person',
      include: 'body',
    });
    expect(bodies).toEqual([
      expect.objectContaining({ title: 'Dana', bodyMd: 'Host of the show.' }),
    ]);
    expect((await call(owner, 'wiki.list', { showId: show.id }))[0]).not.toHaveProperty('bodyMd');

    const stranger = await makeUser('stranger@example.com');
    await failsWith(call(stranger, 'wiki.lint', { showId: show.id }), 'not_found');
    await failsWith(call(stranger, 'wiki.list', { showId: show.id, include: 'body' }), 'not_found');
  });
});
