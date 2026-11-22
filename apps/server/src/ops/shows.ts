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
import { toCategory } from './map.ts';

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
  description: 'Create a show in a team (owner/admin). Starts with default event buttons.',
  kind: 'write',
  surfaces: ['web'],
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
    await ctx.db.insert(categories).values(
      DEFAULT_CATEGORIES.map((c, i) => ({
        id: newId('cat'),
        showId: id,
        position: i,
        name: c.name,
        color: c.color,
        kind: c.kind,
        options: 'options' in c ? c.options : [],
      })),
    );
    return getShow(ctx, id);
  },
});

defineOp({
  name: 'shows.update',
  description:
    'Update show settings (owner/admin); omitted fields stay as they are. Transcription settings apply to transcriptions that run from now on; to apply them to audio already transcribed, re-transcribe the session (media_retranscribe). `smartFormat` (default true) toggles Deepgram smart formatting of numbers, dates and currency; turn it off for technical or math talk, where it turns "x squared" into "x2". `keyTerms` replaces the list of key terms (names and jargon such as "dx" or "L’Hôpital") the transcriber should favour: at most 50 terms of up to 50 characters and 1000 characters in total, duplicates dropped, [] clears it.',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { showId, ...patch }) {
    await requireShow(ctx, showId, 'manage');
    const set: Partial<typeof shows.$inferInsert> = {
      name: patch.name,
      code: patch.code?.toUpperCase(),
      defaultFrameRate: patch.defaultFrameRate,
      titleSuffix: patch.titleSuffix,
      nextEpisode: patch.nextEpisode,
      smartFormat: patch.smartFormat,
      keyTerms: patch.keyTerms && [...new Set(patch.keyTerms)],
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
  description: 'Delete a show and all its sessions (owner/admin).',
  kind: 'write',
  surfaces: ['web'],
  async run(ctx, { showId }) {
    await requireShow(ctx, showId, 'manage');
    await ctx.db.delete(shows).where(eq(shows.id, showId));
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
    'Replace the show’s event buttons with this ordered list (owner/admin). Keep `id` to update an existing button; omit it to add one. Buttons not in the list are removed; past events keep their label.',
  kind: 'write',
  surfaces: ['web'],
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
