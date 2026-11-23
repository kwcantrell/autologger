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
