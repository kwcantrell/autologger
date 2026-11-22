import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

describe('show setup over MCP', () => {
  it('an owner’s agent creates a show and its buttons; changes are logged and undoable', async () => {
    const owner = await makeUser('owner@example.com');
    const team = await call(owner, 'teams.create', { name: 'Studio' });
    const agent = asAgent(owner);

    const show = await call(agent, 'shows.create', { teamId: team.id, name: 'Math Videos' });
    expect(show.access).toBe('manage');
    const defaults = await call(agent, 'categories.list', { showId: show.id });
    expect(defaults.map((c) => c.name)).toEqual(['Scene', 'Audio issue', 'Note']);

    await call(agent, 'shows.update', { showId: show.id, titleSuffix: 'episode' });

    const saved = await call(agent, 'categories.save', {
      showId: show.id,
      categories: [
        { id: defaults[0]!.id, name: 'Chapter', color: '#3B82F6', kind: 'button' },
        { name: 'Proof', color: '#22c55e', kind: 'dropdown', options: ['Start', 'End'] },
        { name: 'On screen', color: '#eab308', kind: 'toggle', onLabel: 'Show', offLabel: 'Hide' },
      ],
    });
    expect(saved.map((c) => [c.position, c.name, c.kind])).toEqual([
      [0, 'Chapter', 'button'],
      [1, 'Proof', 'dropdown'],
      [2, 'On screen', 'toggle'],
    ]);

    const log = await call(agent, 'changes.list', { showId: show.id });
    expect(log.every((c) => c.via === 'mcp' && c.entity === 'category')).toBe(true);
    const summaries = (kind: string) =>
      log
        .filter((c) => c.kind === kind)
        .map((c) => c.summary)
        .sort();
    expect(summaries('create')).toEqual(
      [
        'Added default button “Scene”',
        'Added default button “Audio issue”',
        'Added default button “Note”',
        'Added button “Proof”',
        'Added button “On screen”',
      ].sort(),
    );
    expect(summaries('update')).toEqual(['Edited button “Chapter”']);
    expect(summaries('delete')).toEqual(
      ['Removed button “Audio issue”', 'Removed button “Note”'].sort(),
    );

    const rename = log.find((c) => c.kind === 'update')!;
    await call(agent, 'changes.revert', { changeId: rename.id });
    expect((await call(agent, 'categories.list', { showId: show.id }))[0]!.name).toBe('Scene');
  });

  it('members and outsiders cannot create shows or change buttons', async () => {
    const owner = await makeUser('owner@example.com');
    const team = await call(owner, 'teams.create', { name: 'Studio' });
    const show = await call(owner, 'shows.create', { teamId: team.id, name: 'Math Videos' });
    const member = asAgent(await makeUser('member@example.com'));
    await call(owner, 'teams.invite', { teamId: team.id, email: 'member@example.com' });
    const outsider = asAgent(await makeUser('outsider@example.com'));

    await failsWith(call(member, 'shows.create', { teamId: team.id, name: 'X' }), 'forbidden');
    await failsWith(call(outsider, 'shows.create', { teamId: team.id, name: 'X' }), 'not_found');
    // Without a grant the member cannot see the show at all.
    await failsWith(
      call(member, 'categories.save', { showId: show.id, categories: [] }),
      'not_found',
    );
    await call(owner, 'teams.setGrant', {
      teamId: team.id,
      userId: member.user.id,
      showId: show.id,
      access: 'write',
    });
    await failsWith(
      call(member, 'categories.save', { showId: show.id, categories: [] }),
      'forbidden',
    );
    await failsWith(call(member, 'shows.update', { showId: show.id, name: 'Y' }), 'forbidden');
    await failsWith(call(asAgent(owner), 'shows.delete', { showId: show.id }), 'not_found');
  });
});
