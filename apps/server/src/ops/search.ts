import type { SearchHit } from '@autologger/contract';
import { sql } from 'drizzle-orm';
import { readableShowCondition, requireSession, requireShow } from '../core/authz.ts';
import { defineOp } from '../core/op.ts';

defineOp({
  name: 'search',
  description:
    'Full-text search across everything you can access: events, transcript lines, topics, wiki pages and sessions. Narrow by show, session or kinds. Hits carry sessionId and atSec so you can jump to the moment.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { query, showId, sessionId, kinds, limit }) {
    if (showId) await requireShow(ctx, showId, 'read');
    if (sessionId) await requireSession(ctx, sessionId, 'read');
    const want = new Set(kinds ?? ['event', 'transcript', 'topic', 'wiki', 'session']);
    const q = sql`websearch_to_tsquery('english', ${query})`;
    const scope = (showCol: ReturnType<typeof sql>, sessCol: ReturnType<typeof sql> | null) =>
      sql`${readableShowCondition(ctx, showCol)}
        ${showId ? sql`and ${showCol} = ${showId}` : sql``}
        ${sessionId ? (sessCol ? sql`and ${sessCol} = ${sessionId}` : sql`and false`) : sql``}`;
    const hl = (col: ReturnType<typeof sql>) =>
      sql`ts_headline('english', ${col}, ${q}, 'StartSel=«,StopSel=»,MaxWords=24,MinWords=8,MaxFragments=1')`;

    const parts: ReturnType<typeof sql>[] = [];
    if (want.has('event'))
      parts.push(sql`select 'event' as kind, e.id, e.session_id, s.show_id, s.title as session_title, sh.name as show_name,
        e.category as title, ${hl(sql`e.message || ' ' || coalesce(e.value,'')`)} as snippet,
        greatest(0, (e.timecode_frames - s.start_offset_frames)::float / s.frame_rate) as at_sec, ts_rank(e.search, ${q}) as rank
        from events e join sessions s on s.id = e.session_id join shows sh on sh.id = s.show_id
        where e.search @@ ${q} and ${scope(sql`s.show_id`, sql`e.session_id`)}`);
    if (want.has('transcript'))
      parts.push(sql`select 'transcript', t.id, t.session_id, s.show_id, s.title, sh.name,
        coalesce(nullif(t.speaker,''),'Speaker'), ${hl(sql`t.text`)}, t.start_sec, ts_rank(t.search, ${q})
        from transcript_segments t join sessions s on s.id = t.session_id join shows sh on sh.id = s.show_id
        where t.search @@ ${q} and ${scope(sql`s.show_id`, sql`t.session_id`)}`);
    if (want.has('topic'))
      parts.push(sql`select 'topic', p.id, p.session_id, s.show_id, s.title, sh.name,
        p.title, ${hl(sql`p.title || ' — ' || p.summary`)}, p.start_sec, ts_rank(p.search, ${q}) * 1.5
        from topics p join sessions s on s.id = p.session_id join shows sh on sh.id = s.show_id
        where p.search @@ ${q} and ${scope(sql`s.show_id`, sql`p.session_id`)}`);
    if (want.has('wiki'))
      parts.push(sql`select 'wiki', w.id, w.session_id, w.show_id, null, sh.name,
        w.title, ${hl(sql`w.body_md`)}, null::float, ts_rank(w.search, ${q}) * 1.5
        from wiki_pages w join shows sh on sh.id = w.show_id
        where w.search @@ ${q} and ${scope(sql`w.show_id`, sql`w.session_id`)}`);
    if (want.has('session'))
      parts.push(sql`select 'session', s.id, s.id, s.show_id, s.title, sh.name,
        s.title, ${hl(sql`s.title || ' ' || s.notes`)}, null::float, ts_rank(s.search, ${q}) * 2
        from sessions s join shows sh on sh.id = s.show_id
        where s.search @@ ${q} and ${scope(sql`s.show_id`, sql`s.id`)}`);
    if (parts.length === 0) return [];

    const union = sql.join(parts, sql` union all `);
    const rows = await ctx.db.execute<{
      kind: SearchHit['kind'];
      id: string;
      session_id: string | null;
      show_id: string;
      session_title: string | null;
      show_name: string;
      title: string;
      snippet: string;
      at_sec: number | null;
      rank: number;
    }>(sql`select * from (${union}) hits order by rank desc limit ${limit}`);
    return rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      sessionId: r.session_id,
      showId: r.show_id,
      sessionTitle: r.session_title,
      showName: r.show_name,
      title: r.title,
      snippet: r.snippet,
      atSec: r.at_sec,
      rank: Number(r.rank),
    }));
  },
});
