import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { asAgent, call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

/** A team with two shows, one session each, and a plain member with no show grants. */
async function twoShows() {
  const fx = await studio();
  const { owner, team } = fx;
  const other = await call(owner, 'shows.create', { teamId: team.id, name: 'Morning Pod' });
  const otherSession = await call(owner, 'sessions.create', { showId: other.id, title: 'MP_01' });
  for (const s of [fx.session, otherSession])
    await db.insert(schema.audioSegments).values({
      id: newId('seg'),
      sessionId: s.id,
      ordinal: 1,
      objectKey: `x/${s.id}`,
      mimeType: 'audio/mpeg',
      origin: 'file',
      startSec: 0,
      durationSec: 600,
      status: 'ready',
    });
  const member = await makeUser(`member-${newId('x')}@example.com`);
  await db
    .insert(schema.teamMembers)
    .values({ teamId: team.id, userId: member.user.id, role: 'member' });
  return { ...fx, other, otherSession, member };
}

describe('team wiki', () => {
  it('layers team pages under show pages: links, lookups, lint and backlinks', async () => {
    const { owner, team, show, other, session, otherSession } = await twoShows();
    const dana = await call(owner, 'wiki.upsert', {
      teamId: team.id,
      kind: 'person',
      title: 'Dana Lee',
      aliases: ['DL'],
      bodyMd: `Hosts both shows: [late](@${session.id}:10-20), [morning](@${otherSession.id}:30-40).`,
    });
    expect(dana).toMatchObject({ showId: null, teamId: team.id, badCitations: [] });
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'bit',
      title: 'Cold open',
      bodyMd: 'With [[DL]].',
    });
    await call(owner, 'wiki.upsert', {
      showId: other.id,
      kind: 'bit',
      title: 'Wake up',
      bodyMd: 'With [[Dana Lee]] and [[Nobody]].',
    });

    // A show finds the team page by title, as its links do; lint resolves through the team.
    expect(await call(owner, 'wiki.get', { showId: show.id, title: 'dana lee' })).toMatchObject({
      id: dana.id,
      teamId: team.id,
      backlinkCount: 2,
    });
    expect((await call(owner, 'wiki.lint', { showId: show.id })).counts.unresolvedLinks).toBe(0);
    expect((await call(owner, 'wiki.lint', { showId: other.id })).unresolved).toEqual([
      expect.objectContaining({ title: 'Wake up', targets: ['Nobody'] }),
    ]);
    const teamLint = await call(owner, 'wiki.lint', { teamId: team.id });
    expect(teamLint.orphans).toEqual([]);
    expect(teamLint.counts).toMatchObject({ pages: 1, citations: 2, badCitations: 0 });
    expect((await call(owner, 'wiki.list', { teamId: team.id })).pages.map((p) => p.title)).toEqual(
      ['Dana Lee'],
    );

    // A show page can't take a team page's title; a show page of the same name made before the
    // team page hides it in that show only.
    await failsWith(
      call(owner, 'wiki.upsert', {
        showId: show.id,
        kind: 'person',
        title: 'Dana  LEE',
        bodyMd: '',
      }),
      'conflict',
    );
    await failsWith(
      call(owner, 'wiki.upsert', { teamId: team.id, kind: 'session', title: 'Recap', bodyMd: '' }),
      'bad_request',
    );
    await call(owner, 'wiki.move', { pageId: dana.id, showId: show.id });
    await call(owner, 'wiki.upsert', {
      teamId: team.id,
      kind: 'person',
      title: 'Dana Lee',
      bodyMd: '',
    });
    const teamDana = await call(owner, 'wiki.get', { teamId: team.id, title: 'Dana Lee' });
    expect(teamDana.backlinks.map((b) => [b.title, b.showId])).toEqual([['Wake up', other.id]]);
    expect((await call(owner, 'wiki.get', { showId: show.id, title: 'Dana Lee' })).id).toBe(
      dana.id,
    );
  });

  it('lets every member edit it, moves pages, and undoes from the team change log', async () => {
    const { owner, member, team, show } = await twoShows();
    const outsider = await makeUser(`out-${newId('x')}@example.com`);
    const agent = asAgent(member);
    const page = await call(agent, 'wiki.upsert', {
      teamId: team.id,
      kind: 'topic',
      title: 'Air travel',
      bodyMd: 'Flights.',
    });
    await call(member, 'wiki.patch', { pageId: page.id, append: 'More flights.' });
    await failsWith(call(outsider, 'wiki.get', { pageId: page.id }), 'not_found');
    await failsWith(call(outsider, 'wiki.list', { teamId: team.id }), 'not_found');
    // The member reads no show, so can't move the page into one.
    await failsWith(call(member, 'wiki.move', { pageId: page.id, showId: show.id }), 'not_found');

    const log = await call(member, 'changes.list', { teamId: team.id, grouped: true });
    expect(log.map((c) => [c.summary, c.showId, c.teamId])).toEqual([
      ['Edited wiki page “Air travel”', null, team.id],
      ['Created wiki page “Air travel”', null, team.id],
    ]);
    await call(member, 'changes.revert', { changeId: log[0]!.id });
    expect((await call(member, 'wiki.get', { pageId: page.id })).bodyMd).toBe('Flights.');

    // Promote a show page; undo the move puts it back.
    const bit = await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'bit',
      title: 'Flight Log',
      bodyMd: 'About [[Air travel]].',
    });
    const moved = await call(owner, 'wiki.move', { pageId: bit.id, teamId: team.id });
    expect(moved).toMatchObject({ showId: null, teamId: team.id, badCitations: [] });
    expect((await call(member, 'wiki.get', { pageId: bit.id })).title).toBe('Flight Log');
    const [move] = await call(owner, 'changes.list', { showId: show.id });
    expect(move).toMatchObject({ showId: show.id, teamId: team.id });
    await call(owner, 'changes.revert', { changeId: move!.id });
    expect(await call(owner, 'wiki.get', { pageId: bit.id })).toMatchObject({
      showId: show.id,
      teamId: null,
    });
    await failsWith(call(member, 'wiki.get', { pageId: bit.id }), 'not_found');
  });

  it('puts team pages in each show graph and searches moments across the team', async () => {
    const { owner, team, show, session, otherSession } = await twoShows();
    await call(owner, 'wiki.upsert', {
      teamId: team.id,
      kind: 'person',
      title: 'Dana Lee',
      bodyMd: [
        `- Dana Lee on dogs [dogs](@${session.id}:10-20)`,
        `- Dana Lee on cats [cats](@${otherSession.id}:30-40)`,
      ].join('\n'),
    });
    const showMoments = await call(owner, 'moments.search', {
      showId: show.id,
      entities: ['Dana Lee'],
      kinds: ['citation'],
      compact: false,
    });
    expect(showMoments.moments.map((m) => m.sessionId)).toEqual([session.id]);
    const teamMoments = await call(owner, 'moments.search', {
      teamId: team.id,
      entities: ['Dana Lee'],
      kinds: ['citation'],
      compact: false,
    });
    expect(teamMoments.moments.map((m) => m.sessionId).sort()).toEqual(
      [session.id, otherSession.id].sort(),
    );
    const entity = await call(owner, 'graph.entity', { teamId: team.id, entity: 'Dana Lee' });
    expect(entity).toMatchObject({ showId: null, teamId: team.id, momentCount: 2 });
    expect(entity.sessions).toHaveLength(2);
    const hits = await call(owner, 'search', { query: 'cats', kinds: ['wiki'], showId: show.id });
    expect(hits).toEqual([expect.objectContaining({ showId: null, teamId: team.id })]);
  });
});

describe('team wiki links down to show pages', () => {
  it('resolves a name only one show uses, leaves shared names unresolved', async () => {
    const { owner, team, show, other, session } = await twoShows();
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Late Hub',
      bodyMd: '',
    });
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'bit',
      title: 'Cold open',
      bodyMd: '',
    });
    await call(owner, 'wiki.upsert', {
      showId: other.id,
      kind: 'bit',
      title: 'Cold open',
      bodyMd: '',
    });
    const dana = await call(owner, 'wiki.upsert', {
      teamId: team.id,
      kind: 'person',
      title: 'Dana Lee',
      bodyMd: `- Hosts [[Late Hub]] [00:00:10](@${session.id}:10-20)\n- Opens with [[Cold open]].`,
      compact: true,
    });
    expect(dana.unresolvedLinks).toEqual(['Cold open']);
    const hub = await call(owner, 'wiki.get', { showId: show.id, title: 'Late Hub' });
    expect(hub.backlinks.map((b) => b.title)).toEqual(['Dana Lee']);
    expect(
      (await call(owner, 'wiki.lint', { showId: show.id })).orphans.map((o) => o.title),
    ).toEqual(['Cold open']);
    const [m] = (
      await call(owner, 'moments.search', {
        teamId: team.id,
        entities: ['Dana Lee'],
        kinds: ['citation'],
        compact: false,
      })
    ).moments;
    expect(m!.entities.map((e) => e.title)).toEqual(['Dana Lee', 'Late Hub']);
    // wiki.get by teamId + title stays in the team wiki.
    await failsWith(call(owner, 'wiki.get', { teamId: team.id, title: 'Late Hub' }), 'not_found');
  });

  it('rewrites citation labels whose timecode is off their range', async () => {
    const { owner, show, session } = await twoShows();
    const page = await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Labels',
      bodyMd: `- a [00:01:00](@${session.id}:75-80) b [1:00–1:05 Dana](@${session.id}:30-40) c [00:00:05](@${session.id}:5.4-9)`,
      compact: true,
    });
    expect(page.badCitations).toEqual([]);
    expect(page.relabeledCitations.map((c) => [c.sentLabel, c.label])).toEqual([
      ['00:01:00', '00:01:15'],
      ['1:00–1:05 Dana', '0:30–0:40 Dana'],
    ]);
    const { bodyMd } = await call(owner, 'wiki.get', { pageId: page.id });
    expect(bodyMd).toContain(`[00:01:15](@${session.id}:75-80)`);
    expect(bodyMd).toContain(`[0:30–0:40 Dana](@${session.id}:30-40)`);
    const patched = await call(owner, 'wiki.patch', {
      pageId: page.id,
      append: `- d [00:00:01](@${session.id}:100-110)`,
      compact: true,
    });
    expect(patched.relabeledCitations).toEqual([
      expect.objectContaining({ label: '00:01:40', sentLabel: '00:00:01' }),
    ]);
  });
});
