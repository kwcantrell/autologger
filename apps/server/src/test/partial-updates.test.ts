import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

describe('wiki.patch', () => {
  it('applies exact edits as one revision, refuses ambiguous finds, and undoes', async () => {
    const { owner, show } = await studio();
    const agent = asAgent(owner);
    const page = await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'session',
      title: 'Ep 4 recap',
      bodyMd: 'Dana hurt her knee. Sam laughed. Sam left.',
      sessionId: (await call(owner, 'sessions.list', { showId: show.id }))[0]!.id,
    });

    await failsWith(
      call(agent, 'wiki.patch', { pageId: page.id, edits: [{ find: 'Sam', replace: 'Kim' }] }),
      'bad_request',
    );
    await failsWith(
      call(agent, 'wiki.patch', { pageId: page.id, edits: [{ find: 'nope', replace: 'x' }] }),
      'bad_request',
    );

    const res = await call(agent, 'wiki.patch', {
      pageId: page.id,
      edits: [
        { find: 'Dana hurt', replace: 'Sam hurt' },
        { find: 'Sam laughed', replace: 'Dana laughed' },
      ],
      append: '## Notes\nFixed attribution.',
    });
    expect(res).toMatchObject({ id: page.id, revision: 2 });
    expect(res).not.toHaveProperty('bodyMd');
    expect((await call(owner, 'wiki.get', { pageId: page.id })).bodyMd).toBe(
      'Sam hurt her knee. Dana laughed. Sam left.\n## Notes\nFixed attribution.',
    );
    expect(await call(owner, 'wiki.revisions', { pageId: page.id })).toHaveLength(2);

    const outsider = await makeUser('outsider@example.com');
    await failsWith(call(outsider, 'wiki.patch', { pageId: page.id, append: 'x' }), 'not_found');

    const [latest] = await call(owner, 'changes.list', { showId: show.id, via: 'mcp' });
    expect(latest).toMatchObject({ op: 'wiki.patch', entityId: page.id });
    await call(owner, 'changes.revert', { changeId: latest!.id });
    expect((await call(owner, 'wiki.get', { pageId: page.id })).bodyMd).toBe(
      'Dana hurt her knee. Sam laughed. Sam left.',
    );
  });
});

describe('dashboards.updateWidgets', () => {
  it('merges widget patches by id, validates the result, and undoes', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    const saved = await call(owner, 'dashboards.save', {
      sessionId: session.id,
      spec: {
        title: 'Overview',
        widgets: [
          { id: 'note', type: 'markdown', markdown: 'hi' },
          {
            id: 'cats',
            type: 'bar',
            title: 'Events by a very long label',
            query: { name: 'events_by_category' },
            x: 'category',
            y: 'count',
            labelMaxChars: 12,
          },
        ],
      },
    });

    const original = await call(owner, 'dashboards.get', { dashboardId: saved.id });
    const res = await call(agent, 'dashboards.updateWidgets', {
      dashboardId: saved.id,
      widgets: [{ id: 'cats', title: 'Events', labelMaxChars: null, horizontal: true }],
      compact: true,
    });
    expect(res).toEqual({ id: saved.id, revision: 2 });
    const got = await call(owner, 'dashboards.get', { dashboardId: saved.id });
    expect(got.spec.widgets[0]).toEqual(original.spec.widgets[0]);
    expect(got.spec.widgets[1]).toMatchObject({ id: 'cats', title: 'Events', horizontal: true });
    expect(got.spec.widgets[1]).not.toHaveProperty('labelMaxChars');

    // Unknown ids and invalid merged widgets change nothing.
    await failsWith(
      call(agent, 'dashboards.updateWidgets', {
        dashboardId: saved.id,
        widgets: [{ id: 'nope', title: 'x' }],
      }),
      'bad_request',
    );
    await failsWith(
      call(agent, 'dashboards.updateWidgets', {
        dashboardId: saved.id,
        widgets: [{ id: 'cats', x: null }],
      }),
      'bad_request',
    );
    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'dashboards.updateWidgets', {
        dashboardId: saved.id,
        widgets: [{ id: 'cats', title: 'x' }],
      }),
      'not_found',
    );

    const [latest] = await call(owner, 'changes.list', { sessionId: session.id, via: 'mcp' });
    expect(latest).toMatchObject({ op: 'dashboards.updateWidgets' });
    await call(owner, 'changes.revert', { changeId: latest!.id });
    const reverted = await call(owner, 'dashboards.get', { dashboardId: saved.id });
    expect(reverted).toMatchObject({ revision: 1, spec: original.spec });
  });
});

describe('events.updateMany', () => {
  it('edits several events in one call, all-or-nothing, each undoable', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    const [a, b] = await call(owner, 'events.createMany', {
      sessionId: session.id,
      events: [
        { category: 'Note', message: '3 laughs', atSec: 10 },
        { category: 'Note', message: 'intro', atSec: 20 },
      ],
    });

    const res = await call(agent, 'events.updateMany', {
      sessionId: session.id,
      events: [
        { id: a!.id, message: '4 laughs' },
        { id: b!.id, atSec: 25, category: 'Laugh' },
      ],
      compact: true,
    });
    expect(res).toEqual([
      { id: a!.id, atSec: 10, category: 'Note' },
      { id: b!.id, atSec: 25, category: 'Laugh' },
    ]);
    const list = await call(owner, 'events.list', { sessionId: session.id });
    expect(list.map((e) => [e.message, e.atSec])).toEqual([
      ['4 laughs', 10],
      ['intro', 25],
    ]);

    // An unknown id fails the whole batch.
    await failsWith(
      call(agent, 'events.updateMany', {
        sessionId: session.id,
        events: [
          { id: a!.id, message: 'changed' },
          { id: 'evt_missing', message: 'x' },
        ],
      }),
      'not_found',
    );
    expect((await call(owner, 'events.list', { sessionId: session.id }))[0]!.message).toBe(
      '4 laughs',
    );
    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'events.updateMany', {
        sessionId: session.id,
        events: [{ id: a!.id, message: 'x' }],
      }),
      'not_found',
    );

    const changes = await call(owner, 'changes.list', { sessionId: session.id, via: 'mcp' });
    const forA = changes.find((c) => c.op === 'events.updateMany' && c.entityId === a!.id);
    await call(owner, 'changes.revert', { changeId: forA!.id });
    expect((await call(owner, 'events.list', { sessionId: session.id }))[0]!.message).toBe(
      '3 laughs',
    );
  });
});
