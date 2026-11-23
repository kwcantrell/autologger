import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toRpcError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

describe('dashboard spec validation', () => {
  it('rejects unknown widget fields with their path instead of dropping them', async () => {
    const { owner, session } = await studio();
    // Not an object literal at the call site, so it type-checks like JSON from an agent would.
    const pie = {
      id: 'p',
      type: 'pie',
      label: 'speaker',
      value: 'seconds',
      colour: 'red',
    } as const;
    const err = await call(asAgent(owner), 'dashboards.save', {
      sessionId: session.id,
      spec: {
        title: 'Talk time',
        widgets: [{ id: 'n', type: 'markdown', markdown: 'hi' }, pie],
      },
    }).catch((e: unknown) => e);
    expect(toRpcError(err)).toMatchObject({
      code: 'bad_request',
      issues: [{ path: 'spec.widgets[1].colour', message: expect.stringContaining('colour') }],
    });
  });

  it('keeps format on pie widgets and table columns', async () => {
    const { owner, session } = await studio();
    const widgets = [
      {
        id: 'p',
        type: 'pie' as const,
        query: { name: 'speaker_talk_time' as const },
        label: 'speaker',
        value: 'seconds',
        format: 'minutes' as const,
      },
      {
        id: 't',
        type: 'table' as const,
        query: { name: 'topics' as const },
        columns: [{ key: 'atSec', label: 'At', format: 'duration' as const }, { key: 'label' }],
      },
    ];
    const saved = await call(asAgent(owner), 'dashboards.save', {
      sessionId: session.id,
      spec: { title: 'Talk time', widgets },
    });
    const got = await call(owner, 'dashboards.get', { dashboardId: saved.id });
    expect(got.spec.widgets).toMatchObject(widgets);

    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'dashboards.save', { sessionId: session.id, spec: { title: 'x', widgets } }),
      'not_found',
    );
  });

  it('still loads a stored spec that carries fields saving would now reject', async () => {
    const { owner, session } = await studio();
    const id = newId('dsh');
    await db.insert(schema.dashboards).values({
      id,
      sessionId: session.id,
      title: 'Old',
      spec: {
        version: 1,
        title: 'Old',
        widgets: [{ id: 'p', type: 'pie', label: 'a', value: 'b', span: 2, title: '', legacy: 1 }],
      },
      via: 'web',
      createdBy: owner.user.id,
      updatedBy: owner.user.id,
    });
    expect(await call(owner, 'dashboards.get', { dashboardId: id })).toMatchObject({ id });
  });

  it('keeps an empty state on data widgets and rejects it elsewhere', async () => {
    const { owner, session } = await studio();
    const agent = asAgent(owner);
    const pie = {
      id: 'talk',
      type: 'pie' as const,
      query: { name: 'speaker_talk_time' as const },
      label: 'speaker',
      value: 'seconds',
      emptyText: 'No speech in this session',
    };
    const wpm = {
      id: 'wpm',
      type: 'stat' as const,
      query: { name: 'summary_stats' as const },
      field: 'wpm',
      hideWhenEmpty: true,
    };
    const saved = await call(agent, 'dashboards.save', {
      sessionId: session.id,
      spec: { title: 'Talk', widgets: [pie, wpm] },
    });
    expect(saved.spec.widgets).toMatchObject([pie, wpm]);

    const bad = (widget: Record<string, unknown>) =>
      call(agent, 'dashboards.save', {
        sessionId: session.id,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid widget, as an agent might send
        spec: { title: 'x', widgets: [widget] } as any,
      }).catch((e: unknown) => toRpcError(e));
    expect(
      await bad({ id: 'm', type: 'markdown', markdown: 'hi', emptyText: 'none' }),
    ).toMatchObject({ code: 'bad_request', issues: [{ path: 'spec.widgets[0].emptyText' }] });
    expect(await bad({ ...pie, emptyText: '' })).toMatchObject({ code: 'bad_request' });
    expect(await bad({ ...pie, emptyText: 'x'.repeat(201) })).toMatchObject({
      code: 'bad_request',
    });

    // Patchable like any optional field; null removes it.
    const patched = await call(agent, 'dashboards.updateWidgets', {
      dashboardId: saved.id,
      widgets: [{ id: 'talk', emptyText: null }],
    });
    expect(patched.spec.widgets[0]).not.toHaveProperty('emptyText');

    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'dashboards.save', {
        sessionId: session.id,
        spec: { title: 'x', widgets: [pie] },
      }),
      'not_found',
    );
  });
});

describe('dashboard queries', () => {
  it('reports event atSec rounded to ms, the same value events_list gives', async () => {
    const { owner, session } = await studio();
    // 48.97 s snaps to a whole frame (48.9583… at the default 24 fps).
    await call(owner, 'events.create', { sessionId: session.id, category: 'Laugh', atSec: 48.97 });
    const [listed] = await call(owner, 'events.list', { sessionId: session.id });
    const rows = await call(owner, 'dashboards.query', {
      sessionId: session.id,
      query: { name: 'events', limit: 10 },
    });
    expect(listed!.atSec).toBe(48.958);
    expect(rows).toMatchObject([{ atSec: 48.958, category: 'Laugh' }]);

    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'dashboards.query', {
        sessionId: session.id,
        query: { name: 'events', limit: 10 },
      }),
      'not_found',
    );
  });
});

describe('dashboard queries', () => {
  it('category_count gives one count row for the named categories, 0 when none', async () => {
    const { owner, session } = await studio();
    const count = (categories: string[]) =>
      call(owner, 'dashboards.query', {
        sessionId: session.id,
        query: { name: 'category_count', categories },
      });
    expect(await count(['Key insight'])).toEqual([{ count: 0 }]);
    for (const [category, atSec] of [
      ['Key insight', 5],
      ['Key insight', 9],
      ['Laugh', 12],
    ] as const)
      await call(owner, 'events.create', { sessionId: session.id, category, atSec });
    expect(await count(['Key insight'])).toEqual([{ count: 2 }]);
    expect(await count(['Key insight', 'Laugh'])).toEqual([{ count: 3 }]);

    // A stat over it saves like any other live query.
    await call(asAgent(owner), 'dashboards.save', {
      sessionId: session.id,
      spec: {
        title: 'Insights',
        widgets: [
          { id: 'k', type: 'stat', query: { name: 'category_count', categories: ['Key insight'] } },
        ],
      },
    });

    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'dashboards.query', {
        sessionId: session.id,
        query: { name: 'category_count', categories: ['Key insight'] },
      }),
      'not_found',
    );
  });
});
