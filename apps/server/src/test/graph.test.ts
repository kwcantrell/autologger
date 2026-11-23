import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../core/ids.ts';
import { db, schema } from '../db/client.ts';
import { call, failsWith, makeUser, resetDb, setupDb, studio } from './harness.ts';

beforeAll(setupDb);
beforeEach(resetDb);

/** A show with two episodes, a person, a bit and recaps citing both. */
async function knowledgeShow() {
  const { owner, show, session: ep1 } = await studio();
  await call(owner, 'sessions.update', {
    sessionId: ep1.id,
    title: 'EP_01',
    episodeDate: '2026-07-01',
  });
  const ep2 = await call(owner, 'sessions.create', {
    showId: show.id,
    title: 'EP_02',
    episodeDate: '2026-07-08',
  });
  await call(owner, 'wiki.upsert', {
    showId: show.id,
    kind: 'person',
    title: 'Carly',
    aliases: ['Smut dog'],
    bodyMd: 'Carly is the co-host of Late Night Talk.',
  });
  await call(owner, 'wiki.upsert', {
    showId: show.id,
    kind: 'bit',
    title: 'Pig Talk',
    bodyMd: [
      'Pig Talk is the letters segment.',
      '',
      '## By episode',
      '',
      `- [[Carly]] reads a letter about a moose [EP_01 00:10:00](/sessions/${ep1.id}?t=600&to=660)`,
      `- Joe answers a pig farmer [EP_02 00:05:00](/sessions/${ep2.id}?t=300&to=340)`,
    ].join('\n'),
  });
  await call(owner, 'wiki.upsert', {
    showId: show.id,
    kind: 'session',
    sessionId: ep2.id,
    title: 'EP_02',
    bodyMd: `Episode two. [[Carly]] tells the airport story [00:20:00](@1200-1290) and later a callback [00:21:00](@1260-1300).`,
  });
  await call(owner, 'topics.create', {
    sessionId: ep2.id,
    startSec: 1180,
    durationSec: 200,
    title: 'Airport story',
    summary: 'Carly misses her flight',
  });
  await call(owner, 'events.create', {
    sessionId: ep2.id,
    category: 'Quote',
    message: 'Smut dog strikes again',
    atSec: 1250,
  });
  await db.insert(schema.transcriptSegments).values({
    id: newId('seg'),
    sessionId: ep2.id,
    startSec: 1201,
    endSec: 1206,
    speaker: 'Carly',
    text: 'So I get to the airport gate and it is closed',
    words: [],
  });
  return { owner, show, ep1, ep2 };
}

describe('moments.search', () => {
  it('finds citation moments by entity, tagged with the citing page and linked pages', async () => {
    const { owner, show, ep1, ep2 } = await knowledgeShow();
    const res = await call(owner, 'moments.search', {
      showId: show.id,
      entities: ['carly'],
      kinds: ['citation'],
    });
    expect(
      res.moments.map((m) => [m.sessionId, m.startSec, m.endSec, m.source?.pageTitle]),
    ).toEqual([
      [ep1.id, 600, 660, 'Pig Talk'],
      [ep2.id, 1200, 1290, 'EP_02'],
      [ep2.id, 1260, 1300, 'EP_02'],
    ]);
    expect(res.moments[0]).toMatchObject({
      kind: 'citation',
      title: 'EP_01 00:10:00',
      text: 'Carly reads a letter about a moose',
      source: { pageKind: 'bit', headings: ['By episode'] },
    });
    expect(res.moments[0]!.entities.map((e) => e.title)).toEqual(['Pig Talk', 'Carly']);
    expect(res.total).toBe(3);
  });

  it('matches topics, events and transcript lines by entity names and aliases', async () => {
    const { owner, show } = await knowledgeShow();
    const res = await call(owner, 'moments.search', {
      showId: show.id,
      entities: ['Carly'],
      kinds: ['topic', 'event', 'transcript'],
    });
    // The event names Carly only by her alias; the transcript line says "Carly" only as speaker.
    expect(res.moments.map((m) => m.kind).sort()).toEqual(['event', 'topic']);
    const both = await call(owner, 'moments.search', {
      showId: show.id,
      entities: ['Carly', 'Pig Talk'],
    });
    expect(both.moments.map((m) => m.startSec)).toEqual([600]);
  });

  it('ranks by query and merges a page of moments into clips', async () => {
    const { owner, show, ep2 } = await knowledgeShow();
    const res = await call(owner, 'moments.search', {
      showId: show.id,
      query: 'airport',
      mergeGapSec: 30,
    });
    expect(new Set(res.moments.map((m) => m.kind))).toEqual(
      new Set(['citation', 'topic', 'transcript']),
    );
    expect(res.moments[0]!.kind).toBe('topic');
    // The 200 s topic is longer than maxClipSec (180) and tighter moments cover it: left out.
    expect(res.clips).toEqual([
      expect.objectContaining({ sessionId: ep2.id, startSec: 1200, endSec: 1300 }),
    ]);
    expect(res.clips![0]!.momentIds).toHaveLength(res.moments.length - 1);
    const wide = await call(owner, 'moments.search', {
      showId: show.id,
      query: 'airport',
      mergeGapSec: 30,
      maxClipSec: 600,
    });
    expect(wide.clips).toEqual([expect.objectContaining({ startSec: 1180, endSec: 1380 })]);
    // A tight cap starts a new clip instead of growing one past it.
    const capped = await call(owner, 'moments.search', {
      showId: show.id,
      query: 'airport',
      mergeGapSec: 30,
      maxClipSec: 60,
    });
    expect(capped.clips!.length).toBeGreaterThan(1);
    // Compact (the MCP default) and clips only.
    const small = await call(owner, 'moments.search', {
      showId: show.id,
      query: 'airport',
      mergeGapSec: 30,
      clipsOnly: true,
      compact: true,
    });
    expect(small.moments).toEqual([]);
    expect(small.clips).toEqual([
      {
        sessionId: ep2.id,
        sessionTitle: 'EP_02',
        startSec: 1200,
        endSec: 1300,
        label: '00:20:00 (+2)',
        moments: 3,
      },
    ]);
    const listed = await call(owner, 'moments.search', {
      showId: show.id,
      entities: ['Carly'],
      kinds: ['citation'],
      compact: true,
    });
    expect(listed.moments[0]).toEqual({
      kind: 'citation',
      id: expect.any(String),
      sessionId: expect.any(String),
      sessionTitle: 'EP_01',
      startSec: 600,
      endSec: 660,
      title: 'EP_01 00:10:00',
      text: 'Carly reads a letter about a moose',
      page: 'Pig Talk',
      entities: ['Pig Talk', 'Carly'],
    });
  });

  it('falls back to any word when no moment matches every word of the query', async () => {
    const { owner, show } = await knowledgeShow();
    const res = await call(owner, 'moments.search', { showId: show.id, query: 'moose airport' });
    expect(res.relaxedQuery).toBe(true);
    expect(res.moments.some((m) => m.text.includes('moose'))).toBe(true);
    expect(res.moments.some((m) => m.text.includes('airport'))).toBe(true);
    const strict = await call(owner, 'moments.search', { showId: show.id, query: 'airport story' });
    expect(strict.relaxedQuery).toBeUndefined();
    // Relaxed needs at least half the words: one of four is not enough.
    const thin = await call(owner, 'moments.search', {
      showId: show.id,
      query: 'moose zebra giraffe walrus',
    });
    expect(thin.total).toBe(0);
  });

  it('weighs headings above text, so an item under "Age" ranks first for "age"', async () => {
    const { owner, show, ep1 } = await knowledgeShow();
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'person',
      title: 'Joe',
      bodyMd: [
        '## Age',
        '',
        `- Joe says he is 48 [EP_01 00:02:00](/sessions/${ep1.id}?t=120&to=130)`,
        '',
        '## Music',
        '',
        `- Joe talks about the age of vinyl and an aging, ageing, aged record collection [EP_01 00:03:00](/sessions/${ep1.id}?t=180&to=190)`,
      ].join('\n'),
    });
    const res = await call(owner, 'moments.search', {
      showId: show.id,
      query: 'age',
      entities: ['Joe'],
      kinds: ['citation'],
    });
    expect(res.moments[0]!.startSec).toBe(120);
  });

  it('clamps early events, keeps clips within compilation limits, matches whole words', async () => {
    const { owner, show, ep1, ep2 } = await knowledgeShow();
    // The fixture's first session starts at 01:00:00:00; an event stored before that (older
    // versions allowed it) has a negative time.
    await db.insert(schema.events).values({
      id: newId('evt'),
      sessionId: ep1.id,
      category: 'Quote',
      message: 'Carly early',
      color: '#a3a3a3',
      timecodeFrames: 24 * 3540,
      source: 'operator',
      createdBy: owner.user.id,
    });
    await call(owner, 'topics.create', {
      sessionId: ep2.id,
      startSec: 2000,
      durationSec: 3000,
      title: 'Carly marathon',
    });
    await db.insert(schema.transcriptSegments).values({
      id: newId('seg'),
      sessionId: ep2.id,
      startSec: 5,
      endSec: 6,
      speaker: 'Joe',
      text: 'Carlyle is not Carly-adjacent at all',
      words: [],
    });
    const res = await call(owner, 'moments.search', {
      showId: show.id,
      entities: ['Carly'],
      kinds: ['event', 'topic', 'transcript'],
      mergeGapSec: 1,
    });
    expect(Math.min(...res.moments.map((m) => m.startSec))).toBe(0);
    // "Carly-adjacent" names Carly as a whole word; "Carlyle" alone would not.
    expect(res.moments.filter((m) => m.kind === 'transcript')).toHaveLength(1);
    for (const c of res.clips!) {
      expect(c.endSec - c.startSec).toBeGreaterThanOrEqual(1);
      expect(c.endSec - c.startSec).toBeLessThanOrEqual(20 * 60);
    }
    expect(res.clips!.filter((c) => c.label.startsWith('Carly marathon'))).toHaveLength(3);
    // A query of punctuation only finds nothing instead of failing.
    expect((await call(owner, 'moments.search', { showId: show.id, query: "' '" })).total).toBe(0);
  });

  it('merges citations of the same range from several pages into one moment', async () => {
    const { owner, show, ep2 } = await knowledgeShow();
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Air travel',
      bodyMd: `- [[Carly]] misses her flight [EP_02 00:20:00](/sessions/${ep2.id}?t=1200&to=1290)`,
    });
    const res = await call(owner, 'moments.search', {
      showId: show.id,
      entities: ['Carly'],
      kinds: ['citation'],
    });
    const airport = res.moments.filter((m) => m.startSec === 1200);
    expect(airport).toHaveLength(1);
    expect(airport[0]!.alsoCitedBy?.map((c) => c.pageTitle)).toEqual(['Air travel']);
    expect(airport[0]!.entities.map((e) => e.title).sort()).toEqual([
      'Air travel',
      'Carly',
      'EP_02',
    ]);
    expect(res.total).toBe(3);
  });

  it('tags a list item citation with every page the item links, a paragraph only its sentence', async () => {
    const { owner, show, ep2 } = await knowledgeShow();
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Greetings',
      bodyMd: [
        `- [[Carly]] picks her own nickname. The [[Pig Talk]] email greets the hounds [EP_02 00:30:00](/sessions/${ep2.id}?t=1800&to=1830) and Joe moves on [EP_02 00:31:00](/sessions/${ep2.id}?t=1860&to=1870).`,
        '',
        `- Dates: [[Carly]] at home [EP_02 00:50:00](@${ep2.id}:3000-3010); a [[Pig Talk]] taping [EP_02 00:51:00](@${ep2.id}:3060-3070); a cruise [EP_02 00:52:00](@${ep2.id}:3120-3130); a club [EP_02 00:53:00](@${ep2.id}:3180-3190).`,
        '',
        `[[Carly]] laughs. Joe reads a [[Pig Talk]] letter [EP_02 00:40:00](/sessions/${ep2.id}?t=2400&to=2410). Then an ad [EP_02 00:41:00](/sessions/${ep2.id}?t=2460&to=2470).`,
      ].join('\n'),
    });
    const res = await call(owner, 'moments.search', {
      showId: show.id,
      entities: ['Carly', 'Pig Talk'],
      kinds: ['citation'],
    });
    // Both citations of the short item; none from the 4-citation list of dates (read per
    // sentence) or the paragraph (Carly is a sentence away from each).
    expect(
      res.moments.filter((m) => m.source?.pageTitle === 'Greetings').map((m) => m.startSec),
    ).toEqual([1800, 1860]);
    const item = res.moments.find((m) => m.startSec === 1860)!;
    expect(item.text).toContain('Joe moves on');
  });

  it('tags guide rows by their own cell, skips Note events, orders by episode number', async () => {
    const { owner, show, ep1, ep2 } = await knowledgeShow();
    // Dates say EP_02 aired first; the episode numbers say otherwise and win.
    await call(owner, 'sessions.update', {
      sessionId: ep1.id,
      episode: '1',
      episodeDate: '2026-08-01',
    });
    await call(owner, 'sessions.update', {
      sessionId: ep2.id,
      episode: '2',
      episodeDate: '2026-07-01',
    });
    await call(owner, 'wiki.upsert', {
      showId: show.id,
      kind: 'topic',
      title: 'Guide',
      bodyMd: [
        '| Ep | Recap | What happens | Segments |',
        '|---|---|---|---|',
        `| 2 | [[EP_02]] | The airport story [EP_02 00:20:00](/sessions/${ep2.id}?t=1200&to=1230) | [[Pig Talk]] |`,
      ].join('\n'),
    });
    await call(owner, 'events.create', {
      sessionId: ep2.id,
      category: 'Note',
      message: 'Carly named by hand',
      atSec: 10,
    });
    const pig = await call(owner, 'moments.search', { showId: show.id, entities: ['Pig Talk'] });
    expect(pig.moments.some((m) => m.source?.pageTitle === 'Guide')).toBe(false);
    const row = await call(owner, 'moments.search', {
      showId: show.id,
      entities: ['Guide'],
      kinds: ['citation'],
    });
    expect(row.moments[0]!.entities.map((e) => e.title)).toEqual(['Guide', 'EP_02']);
    const carly = await call(owner, 'moments.search', { showId: show.id, entities: ['Carly'] });
    expect(carly.moments.some((m) => m.title === 'Note')).toBe(false);
    expect(carly.moments[0]!.sessionId).toBe(ep1.id);
    const notes = await call(owner, 'moments.search', { showId: show.id, query: 'named by hand' });
    expect(notes.moments.map((m) => m.title)).toContain('Note');
  });

  it('reports unknown entities, pages, and hides other shows', async () => {
    const { owner, show } = await knowledgeShow();
    const none = await call(owner, 'moments.search', { showId: show.id, entities: ['Nobody'] });
    expect(none).toMatchObject({ total: 0, unknownEntities: ['Nobody'] });
    const first = await call(owner, 'moments.search', {
      showId: show.id,
      entities: ['Carly'],
      limit: 2,
    });
    expect(first.nextOffset).toBe(2);
    await failsWith(call(owner, 'moments.search', { showId: show.id }), 'bad_request');
    const outsider = await makeUser('outsider@example.com');
    await failsWith(
      call(outsider, 'moments.search', { showId: show.id, query: 'airport' }),
      'not_found',
    );
  });
});

describe('graph.entity', () => {
  it('lists sessions, moments and related pages of an entity', async () => {
    const { owner, show, ep1, ep2 } = await knowledgeShow();
    const carly = await call(owner, 'graph.entity', { showId: show.id, entity: 'Smut dog' });
    expect(carly).toMatchObject({ title: 'Carly', kind: 'person', momentCount: 3 });
    expect(carly.sessions.map((s) => [s.sessionId, s.moments])).toEqual([
      [ep1.id, 1],
      [ep2.id, 2],
    ]);
    expect(carly.related.map((r) => [r.title, r.via.sort()])).toEqual([
      ['EP_02', ['coCited', 'linkedFrom']],
      ['Pig Talk', ['coCited', 'linkedFrom']],
    ]);
    await failsWith(
      call(owner, 'graph.entity', { showId: show.id, entity: 'Nobody' }),
      'not_found',
    );
  });
});

describe('graph.export', () => {
  it('exports nodes, edges, moments and chunks as rows, and JSON-LD', async () => {
    const { owner, show, ep2 } = await knowledgeShow();
    const all = await call(owner, 'graph.export', { showId: show.id, limit: 5000 });
    if (all.format !== 'jsonl') throw new Error('expected rows');
    const types = all.rows.map((r) => r.type);
    expect(types.filter((t) => t === 'node')).toHaveLength(1 + 2 + 3);
    expect(all.rows).toContainEqual(
      expect.objectContaining({ type: 'edge', label: 'APPEARS_IN', to: ep2.id, moments: 2 }),
    );
    const chunks = all.rows.filter((r) => r.type === 'chunk');
    expect(chunks).toContainEqual(
      expect.objectContaining({ context: 'Late Night Talk › Pig Talk › By episode' }),
    );
    const paged = await call(owner, 'graph.export', {
      showId: show.id,
      section: 'moments',
      limit: 2,
    });
    if (paged.format !== 'jsonl') throw new Error('expected rows');
    expect(paged).toMatchObject({ total: 6, nextOffset: 2 });

    const ld = await call(owner, 'graph.export', { showId: show.id, format: 'jsonld' });
    if (ld.format !== 'jsonld') throw new Error('expected JSON-LD');
    const graph = ld.document['@graph'] as Record<string, unknown>[];
    expect(graph).toContainEqual(
      expect.objectContaining({ '@type': 'PodcastEpisode', name: 'EP_02', position: 2 }),
    );
    expect(graph).toContainEqual(
      expect.objectContaining({ '@type': 'Person', name: 'Carly', alternateName: ['Smut dog'] }),
    );
    expect(graph.filter((n) => (n['@type'] as string[])[0] === 'Clip')).toHaveLength(6);
  });
});
