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
    expect(res.clips).toEqual([
      expect.objectContaining({ sessionId: ep2.id, startSec: 1180, endSec: 1380 }),
    ]);
    expect(res.clips![0]!.momentIds).toHaveLength(res.moments.length);
  });

  it('falls back to any word when no moment matches every word of the query', async () => {
    const { owner, show } = await knowledgeShow();
    const res = await call(owner, 'moments.search', { showId: show.id, query: 'moose airport' });
    expect(res.relaxedQuery).toBe(true);
    expect(res.moments.some((m) => m.text.includes('moose'))).toBe(true);
    expect(res.moments.some((m) => m.text.includes('airport'))).toBe(true);
    const strict = await call(owner, 'moments.search', { showId: show.id, query: 'airport story' });
    expect(strict.relaxedQuery).toBeUndefined();
  });

  it('clamps early events, keeps clips within compilation limits, matches whole words', async () => {
    const { owner, show, ep1, ep2 } = await knowledgeShow();
    // The fixture's first session starts at 01:00:00:00; an event stored before that (older
    // versions allowed it) has a negative time.
    await db.insert(schema.events).values({
      id: newId('evt'),
      sessionId: ep1.id,
      category: 'Note',
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
