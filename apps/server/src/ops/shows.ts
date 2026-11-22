import type { Category, Show, ShowAccess } from '@autologger/contract';
import { and, asc, eq, notInArray, type SQL, sql } from 'drizzle-orm';
import {
  readableShowCondition,
  requireShow,
  requireTeamRole,
  showAccessMap,
} from '../core/authz.ts';
import { newId } from '../core/ids.ts';
import { type Ctx, defineOp, snapshot } from '../core/op.ts';
import { schema } from '../db/client.ts';
import { checkRules } from '../media/rules.ts';
import { toCategory } from './map.ts';
import { deleteSessionMedia } from './sessions.ts';

const { shows, teams, categories } = schema;

export const DEFAULT_CATEGORIES = [
  { name: 'Scene', color: '#3b82f6', kind: 'button' as const },
  {
    name: 'Audio issue',
    color: '#ef4444',
    kind: 'dropdown' as const,
    options: ['Lav', 'Boom', 'Noise', 'Clipping'],
  },
  { name: 'Note', color: '#a3a3a3', kind: 'text' as const },
];

export function suggestedCode(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const code =
    words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'SHOW').slice(0, 4);
  return code.slice(0, 8) || 'SHOW';
}

async function loadShows(ctx: Ctx, where: SQL | undefined): Promise<Show[]> {
  const rows = await ctx.db
    .select({
      show: shows,
      teamName: teams.name,
      sessionCount: sql<number>`(select count(*)::int from sessions s where s.show_id = ${shows.id} and s.archived_at is null)`,
      lastSessionAt: sql<Date | null>`(select max(s.created_at) from sessions s where s.show_id = ${shows.id})`,
    })
    .from(shows)
    .innerJoin(teams, eq(teams.id, shows.teamId))
    .where(and(readableShowCondition(ctx, shows.id), where))
    .orderBy(asc(teams.name), asc(shows.name));
  const access = await showAccessMap(
    ctx,
    rows.map((r) => r.show),
  );
  return rows
    .filter((r) => access.has(r.show.id))
    .map((r) => toShow(r.show, r.teamName, access, r.sessionCount, r.lastSessionAt));
}

function toShow(
  s: typeof shows.$inferSelect,
  teamName: string,
  access: Map<string, ShowAccess>,
  sessionCount: number,
  lastSessionAt: Date | string | null,
): Show {
  return {
    id: s.id,
    teamId: s.teamId,
    teamName,
    name: s.name,
    code: s.code,
    nextEpisode: s.nextEpisode,
    defaultFrameRate: s.defaultFrameRate,
    titleSuffix: s.titleSuffix,
    smartFormat: s.smartFormat,
    keyTerms: s.keyTerms,
    transcriptRules: s.transcriptRules,
    createdAt: s.createdAt.toISOString(),
    access: access.get(s.id)!,
    sessionCount,
    lastSessionAt: lastSessionAt ? new Date(lastSessionAt).toISOString() : null,
  };
}

export async function getShow(ctx: Ctx, showId: string): Promise<Show> {
  await requireShow(ctx, showId, 'read');
  const [s] = await loadShows(ctx, eq(shows.id, showId));
  return s!;
}

export async function listCategories(ctx: Ctx, showId: string): Promise<Category[]> {
  const rows = await ctx.db
    .select()
    .from(categories)
    .where(eq(categories.showId, showId))
    .orderBy(asc(categories.position));
  return rows.map(toCategory);
}

defineOp({
  name: 'shows.list',
  description:
    'Shows you can access, across all your teams (or one team). Includes your access level.',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  run: (ctx, { teamId }) => loadShows(ctx, teamId ? eq(shows.teamId, teamId) : undefined),
});

defineOp({
  name: 'shows.get',
  description: 'One show with its event buttons (categories).',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { showId }) {
    const show = await getShow(ctx, showId);
    return { ...show, categories: await listCategories(ctx, showId) };
  },
});

defineOp({
  name: 'shows.create',
  description:
    'Create a show (a series of sessions, e.g. a podcast or channel) in a team. Needs the owner or admin role in that team; teamId comes from teams_list (check `role`). `code` is a short uppercase prefix for default session titles (derived from the name when omitted); defaultFrameRate is the frame rate new sessions start with (default 24). The show starts with three default event buttons, in hotkey order: "Scene" (button), "Audio issue" (dropdown: Lav, Boom, Noise, Clipping) and "Note" (text) — replace or extend them with categories_save. Creating those buttons is recorded in the change log; the show itself is removed only from the web app.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { teamId, name, code, defaultFrameRate }) {
    await requireTeamRole(ctx, teamId, 'admin');
    const id = newId('show');
    await ctx.db.insert(shows).values({
      id,
      teamId,
      name,
      code: (code || suggestedCode(name)).toUpperCase(),
      defaultFrameRate,
    });
    const created = await ctx.db
      .insert(categories)
      .values(
        DEFAULT_CATEGORIES.map((c, i) => ({
          id: newId('cat'),
          showId: id,
          position: i,
          name: c.name,
          color: c.color,
          kind: c.kind,
          options: 'options' in c ? c.options : [],
        })),
      )
      .returning();
    for (const c of created) {
      await ctx.record({
        entity: 'category',
        entityId: c.id,
        kind: 'create',
        summary: `Added default button “${c.name}”`,
        showId: id,
        after: snapshot(c),
      });
    }
    return getShow(ctx, id);
  },
});

defineOp({
  name: 'shows.update',
  description:
    'Change show settings (owner/admin of the show’s team; showId from shows_list). Only the fields you pass change: name, code (session-title prefix, uppercased), defaultFrameRate (for new sessions), titleSuffix (default title of new sessions created without one: "date" = CODE + date, "episode" = CODE + episode number, "none" = the show name) and nextEpisode (the episode number the next session gets). Transcription: `smartFormat` (default true) toggles Deepgram smart formatting of numbers, dates and currency; turn it off for technical or math talk, where it turns "x squared" into "x2". `keyTerms` replaces the list of key terms (names and jargon such as "dx" or "L’Hôpital") the transcriber should favour: at most 50 terms of up to 50 characters and 1000 characters in total, duplicates dropped, [] clears it. Every term is sent with every transcription of the show, and the transcriber pushes key terms into audio that doesn’t contain them (a guest’s name turning up in other episodes), so keep show-wide terms to names and jargon that recur in every session (hosts, the show’s name) and set per-episode terms such as guest names on the session (sessions_update keyTerms). A finished transcribe job’s `progress` (jobs_list) reports how often each key term appears in the new transcript; an unexpected count flags this. `transcriptRules` replaces the ordered list of find/replace rules applied to every new transcription before it is stored (and again on every re-transcription), e.g. `{ find: "doctor", replace: "dr", wholeWord: true }`: at most 100 rules, `find` and `replace` up to 200 characters. `find` is plain text unless `regex: true`, then a PostgreSQL regular expression (the same dialect as transcript_find; `\\1`…`\\9` in `replace` insert capture groups). `wholeWord` only matches where `find` is not part of a longer word; matching is case-insensitive unless `caseSensitive: true`. Literal (non-regex) case-insensitive rules keep the case of each match unless `preserveCase: false`: a match starting with a capital gets its replacement capitalised ("The doctor" with `the doctor → the dr` gives "The dr"), an ALL CAPS match gets a one-word replacement upper-cased, and a replacement with a capital after its first letter ("FUBU", "iPhone") always goes in as written. Rules run in order, each seeing the output of the ones before it. [] clears them. Invalid regexes and regexes that match empty text are rejected (bad_request). In the transcription job each rule may run at most 2 s; a rule that fails or times out is skipped and named in the job result. Transcription settings apply to transcriptions that run from now on; to apply them to audio already transcribed, re-transcribe the session (media_retranscribe), or apply the rules to the existing transcript with transcript_replace, which keeps manual edits. Event buttons are edited with categories_save. Settings changes are not in the change log and cannot be undone from it.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { showId, ...patch }) {
    await requireShow(ctx, showId, 'manage');
    if (patch.transcriptRules) await checkRules(ctx.db, patch.transcriptRules);
    const set: Partial<typeof shows.$inferInsert> = {
      name: patch.name,
      code: patch.code?.toUpperCase(),
      defaultFrameRate: patch.defaultFrameRate,
      titleSuffix: patch.titleSuffix,
      nextEpisode: patch.nextEpisode,
      smartFormat: patch.smartFormat,
      keyTerms: patch.keyTerms && [...new Set(patch.keyTerms)],
      transcriptRules: patch.transcriptRules,
    };
    for (const k of Object.keys(set) as (keyof typeof set)[])
      if (set[k] === undefined) delete set[k];
    if (Object.keys(set).length) await ctx.db.update(shows).set(set).where(eq(shows.id, showId));
    ctx.publish(`show:${showId}`, { type: 'show_changed', showId, entity: 'show' });
    return getShow(ctx, showId);
  },
});

defineOp({
  name: 'shows.delete',
  description:
    'Delete a show and all its sessions (owner/admin), including their stored audio and waveforms.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { showId }) {
    await requireShow(ctx, showId, 'manage');
    const doomed = await ctx.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.showId, showId));
    await ctx.db.delete(shows).where(eq(shows.id, showId));
    deleteSessionMedia(
      ctx,
      doomed.map((s) => s.id),
    );
    ctx.publish(`show:${showId}`, { type: 'closed', reason: 'deleted' });
    return { deleted: true };
  },
});

defineOp({
  name: 'categories.list',
  description: 'The event buttons of a show, in hotkey order (position 0 = key 1).',
  kind: 'read',
  surfaces: ['web', 'mcp'],
  async run(ctx, { showId }) {
    await requireShow(ctx, showId, 'read');
    return listCategories(ctx, showId);
  },
});

defineOp({
  name: 'categories.save',
  description:
    'Set a show’s event buttons (owner/admin of the show’s team). This REPLACES the whole list: send every button you want to keep, in order — read the current ones with categories_list (or shows_get) first. Pass a button’s `id` to keep and update it; omit `id` to add a new one; any existing button missing from the list is deleted (events already logged with it keep their label). Order sets the hotkeys: the first button is key 1, the ninth key 9; later ones have no hotkey. Max 40. Each button: name, color (#rrggbb), kind — "button" (one press logs an event), "dropdown" (the operator picks one of `options`, which becomes the event message; options only apply to dropdowns), "text" (the operator types a message), or "toggle" (each press flips on/off and logs value ON/OFF with `onLabel`/`offLabel`, default "ON"/"OFF", as the message). Every add, edit and removal is recorded in the change log and can be undone. Returns the saved list.',
  kind: 'write',
  surfaces: ['web', 'mcp'],
  async run(ctx, { showId, categories: list }) {
    await requireShow(ctx, showId, 'manage');
    const existing = await ctx.db.select().from(categories).where(eq(categories.showId, showId));
    const byId = new Map(existing.map((c) => [c.id, c]));
    const keepIds = list.map((c) => c.id).filter((x): x is string => Boolean(x && byId.has(x)));
    const removed = existing.filter((c) => !keepIds.includes(c.id));
    if (removed.length) {
      await ctx.db
        .delete(categories)
        .where(
          and(
            eq(categories.showId, showId),
            keepIds.length ? notInArray(categories.id, keepIds) : undefined,
          ),
        );
      for (const c of removed) {
        await ctx.record({
          entity: 'category',
          entityId: c.id,
          kind: 'delete',
          summary: `Removed button “${c.name}”`,
          showId,
          before: snapshot(c),
        });
      }
    }
    for (const [position, c] of list.entries()) {
      const values = {
        position,
        name: c.name,
        color: c.color.toLowerCase(),
        kind: c.kind,
        options: c.kind === 'dropdown' ? c.options : [],
        onLabel: c.onLabel,
        offLabel: c.offLabel,
      };
      const prev = c.id ? byId.get(c.id) : undefined;
      if (prev) {
        const [after] = await ctx.db
          .update(categories)
          .set(values)
          .where(eq(categories.id, prev.id))
          .returning();
        const changed =
          (['name', 'color', 'kind', 'position', 'onLabel', 'offLabel'] as const).some(
            (k) => prev[k] !== after![k],
          ) || JSON.stringify(prev.options) !== JSON.stringify(after!.options);
        if (changed) {
          await ctx.record({
            entity: 'category',
            entityId: prev.id,
            kind: 'update',
            summary: `Edited button “${c.name}”`,
            showId,
            before: snapshot(prev),
            after: snapshot(after),
          });
        }
      } else {
        const [after] = await ctx.db
          .insert(categories)
          .values({ id: newId('cat'), showId, ...values })
          .returning();
        await ctx.record({
          entity: 'category',
          entityId: after!.id,
          kind: 'create',
          summary: `Added button “${c.name}”`,
          showId,
          after: snapshot(after),
        });
      }
    }
    ctx.publish(`show:${showId}`, { type: 'show_changed', showId, entity: 'category' });
    return listCategories(ctx, showId);
  },
});
