// Row → API entity mappers. Keep the wire shapes in packages/contract/src/entities.ts.

import type {
  AudioSegment,
  Category,
  Dashboard,
  DashboardSpec,
  SessionEvent,
  Topic,
  TranscriptSegment,
  UserRef,
  Via,
} from '@autologger/contract';
import { inArray } from 'drizzle-orm';
import { schema, type Tx } from '../db/client.ts';

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Resolve user ids to `{ id, name }` refs in one query. */
export async function userRefs(
  db: Tx,
  ids: (string | null | undefined)[],
): Promise<Map<string, UserRef>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(inArray(schema.users.id, unique));
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name || r.email }]));
}

const ref = (m: Map<string, UserRef>, id: string | null) => (id ? (m.get(id) ?? null) : null);

export function toCategory(r: Row<typeof schema.categories>): Category {
  return {
    id: r.id,
    showId: r.showId,
    position: r.position,
    name: r.name,
    color: r.color,
    kind: r.kind,
    options: r.options,
    onLabel: r.onLabel,
    offLabel: r.offLabel,
  };
}

export function toEvent(r: Row<typeof schema.events>, users: Map<string, UserRef>): SessionEvent {
  return {
    id: r.id,
    sessionId: r.sessionId,
    categoryId: r.categoryId,
    category: r.category,
    color: r.color,
    message: r.message,
    value: r.value,
    timecodeFrames: r.timecodeFrames,
    wallTime: r.wallTime.toISOString(),
    take: r.take,
    source: r.source,
    createdBy: ref(users, r.createdBy),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toTopic(r: Row<typeof schema.topics>, users: Map<string, UserRef>): Topic {
  return {
    id: r.id,
    sessionId: r.sessionId,
    startSec: r.startSec,
    durationSec: r.durationSec,
    level: r.level,
    title: r.title,
    summary: r.summary,
    createdBy: ref(users, r.createdBy),
    via: r.via as Via,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toTranscriptSegment(r: Row<typeof schema.transcriptSegments>): TranscriptSegment {
  return {
    id: r.id,
    sessionId: r.sessionId,
    audioSegmentId: r.audioSegmentId,
    startSec: r.startSec,
    endSec: r.endSec,
    speaker: r.speaker,
    text: r.text,
    words: r.words,
    edited: r.edited,
  };
}

export function toAudioSegment(r: Row<typeof schema.audioSegments>): AudioSegment {
  return {
    id: r.id,
    sessionId: r.sessionId,
    ordinal: r.ordinal,
    startSec: r.startSec,
    durationSec: r.durationSec,
    mimeType: r.mimeType,
    origin: r.origin,
    fileName: r.fileName,
    status: r.status,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toDashboard(
  r: Row<typeof schema.dashboards>,
  users: Map<string, UserRef>,
): Dashboard {
  return {
    id: r.id,
    sessionId: r.sessionId,
    title: r.title,
    spec: r.spec as DashboardSpec,
    revision: r.revision,
    createdBy: ref(users, r.createdBy),
    updatedBy: ref(users, r.updatedBy),
    via: r.via as Via,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
