import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: Error) => e.message,
  );

describe('teams over MCP', () => {
  it('an approved user’s agent creates a team, owns it and adds a show', async () => {
    const agent = asAgent(await makeUser('owner@example.com'));
    const team = await call(agent, 'teams.create', { name: '3b1b-2' });
    expect(team).toMatchObject({ name: '3b1b-2', role: 'owner' });
    expect(await call(agent, 'teams.list', {})).toEqual([team]);
    const show = await call(agent, 'shows.create', { teamId: team.id, name: 'Calculus' });
    expect(show.access).toBe('manage');
  });

  it('a pending user gets the same approval error as on the web', async () => {
    const pending = await makeUser('pending@example.com', { status: 'pending' });
    const web = await errorOf(call(pending, 'teams.create', { name: 'X' }));
    const mcp = await errorOf(call(asAgent(pending), 'teams.create', { name: 'X' }));
    expect(web).toMatch(/waiting for approval/);
    expect(mcp).toBe(web);
    await failsWith(call(asAgent(pending), 'teams.create', { name: 'X' }), 'forbidden');
    expect(await call(pending, 'me.get', {})).toMatchObject({ teams: [] });
  });

  it('other team management stays web-only', async () => {
    const agent = asAgent(await makeUser('owner@example.com'));
    const team = await call(agent, 'teams.create', { name: 'Studio' });
    await failsWith(call(agent, 'teams.delete', { teamId: team.id }), 'not_found');
    await failsWith(
      call(agent, 'teams.invite', { teamId: team.id, email: 'x@example.com' }),
      'not_found',
    );
  });
});
