// The op catalog: every capability of AutoLogger, its input schema and output type.
// The server implements each op once; HTTP RPC, MCP tools and the Companion socket all
// dispatch through it. Descriptions live with the server implementation.

import { z } from 'zod';
import { DashboardQuery, DashboardSpec } from './dashboard.ts';
import type {
  AdminUser,
  ApiToken,
  AudioSegment,
  Category,
  Change,
  CompanionDevice,
  Dashboard,
  Job,
  Me,
  SearchHit,
  Session,
  SessionEvent,
  Show,
  Team,
  TeamDetail,
  Topic,
  TranscriptFindId,
  TranscriptFindLine,
  TranscriptLine,
  TranscriptReplaceResult,
  TranscriptSegment,
  WikiPage,
  WikiPageSummary,
  WikiRevision,
} from './entities.ts';
import { MAX_TRANSCRIPT_RULES, TranscriptRuleInput } from './transcriptRules.ts';

const id = z.string().min(1).max(64);
const name = z.string().trim().min(1).max(200);

/** Show transcription key terms (Deepgram keyterm prompting caps a request at ~500 tokens). */
export const MAX_KEY_TERMS = 50;
export const MAX_KEY_TERM_LENGTH = 50;
/** Budget for all key terms together (trimmed characters), keeping a request under ~500 tokens. */
export const MAX_KEY_TERMS_TOTAL_CHARS = 1000;
/** Characters a key term list spends of MAX_KEY_TERMS_TOTAL_CHARS. */
export const keyTermsChars = (terms: string[]): number =>
  terms.reduce((n, t) => n + t.trim().length, 0);
const teamRole = z.enum(['owner', 'admin', 'member']);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const sec = z
  .number()
  .min(0)
  .max(7 * 24 * 3600);
/** A timecode string `HH:MM:SS[:FF]` in the session's frame rate. */
const timecode = z.string().regex(/^\d{1,2}:\d{2}:\d{2}(?:[:;.]\d{2})?$/);

export const CategoryInput = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(60),
  color,
  kind: z.enum(['button', 'dropdown', 'text', 'toggle']).default('button'),
  options: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  onLabel: z.string().max(20).default('ON'),
  offLabel: z.string().max(20).default('OFF'),
});

const EventFields = {
  /** Category id from the show's event buttons. */
  categoryId: id.optional(),
  /** Category name; used when categoryId is not given (matched case-insensitively, or kept as a free label). */
  category: z.string().trim().max(60).optional(),
  message: z.string().max(5000).default(''),
  value: z.string().max(200).nullable().optional(),
  /** Absolute timecode on the session clock. */
  timecode: timecode.optional(),
  /** Session seconds from transport zero (alternative to `timecode`). */
  atSec: sec.optional(),
};

const TopicFields = {
  startSec: sec,
  durationSec: sec.default(0),
  level: z.number().int().min(1).max(3).default(1),
  title: z.string().trim().min(1).max(300),
  summary: z.string().max(10000).default(''),
};

/** Bulk write ops: return a small acknowledgement instead of echoing every written entity. */
const compact = z.boolean().default(false);

export const opInputs = {
  // ── me / auth ─────────────────────────────────────────────
  'me.get': z.object({}),
  'me.update': z.object({ name: name.optional() }),

  // ── teams ────────────────────────────────────────────────
  'teams.list': z.object({}),
  'teams.get': z.object({ teamId: id }),
  'teams.create': z.object({ name }),
  'teams.rename': z.object({ teamId: id, name }),
  'teams.delete': z.object({ teamId: id }),
  'teams.invite': z.object({
    teamId: id,
    email: z.email(),
    role: teamRole.exclude(['owner']).default('member'),
  }),
  'teams.revokeInvite': z.object({ teamId: id, email: z.email() }),
  'teams.setRole': z.object({ teamId: id, userId: id, role: teamRole.exclude(['owner']) }),
  'teams.removeMember': z.object({ teamId: id, userId: id }),
  'teams.leave': z.object({ teamId: id }),
  'teams.transferOwnership': z.object({ teamId: id, userId: id }),
  'teams.setGrant': z.object({
    teamId: id,
    userId: id,
    showId: id,
    access: z.enum(['none', 'read', 'write']),
  }),

  // ── shows + event buttons ─────────────────────────────────
  'shows.list': z.object({ teamId: id.optional() }),
  'shows.get': z.object({ showId: id }),
  'shows.create': z.object({
    teamId: id,
    name,
    code: z.string().trim().max(12).optional(),
    defaultFrameRate: z.number().positive().max(120).default(24),
  }),
  'shows.update': z.object({
    showId: id,
    name: name.optional(),
    code: z.string().trim().min(1).max(12).optional(),
    defaultFrameRate: z.number().positive().max(120).optional(),
    titleSuffix: z.enum(['date', 'episode', 'none']).optional(),
    nextEpisode: z.number().int().min(1).optional(),
    smartFormat: z.boolean().optional(),
    keyTerms: z
      .array(z.string().trim().min(1).max(MAX_KEY_TERM_LENGTH))
      .max(MAX_KEY_TERMS)
      .refine((terms) => keyTermsChars(terms) <= MAX_KEY_TERMS_TOTAL_CHARS, {
        message: `Key terms may total at most ${MAX_KEY_TERMS_TOTAL_CHARS} characters (Deepgram limits key terms to about 500 tokens per request).`,
      })
      .optional(),
    transcriptRules: z.array(TranscriptRuleInput).max(MAX_TRANSCRIPT_RULES).optional(),
  }),
  'shows.delete': z.object({ showId: id }),
  'categories.list': z.object({ showId: id }),
  'categories.save': z.object({ showId: id, categories: z.array(CategoryInput).max(40) }),

  // ── sessions + transport ──────────────────────────────────
  'sessions.list': z.object({
    showId: id.optional(),
    includeArchived: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  'sessions.get': z.object({ sessionId: id }),
  'sessions.create': z.object({
    showId: id,
    title: z.string().trim().max(200).optional(),
    episode: z.string().trim().max(40).optional(),
    episodeDate: z.iso.date().optional(),
    frameRate: z.number().positive().max(120).optional(),
    startTimecode: timecode.optional(),
    notes: z.string().max(10000).optional(),
  }),
  'sessions.update': z.object({
    sessionId: id,
    title: z.string().trim().max(200).optional(),
    episode: z.string().trim().max(40).optional(),
    episodeDate: z.iso.date().nullable().optional(),
    notes: z.string().max(10000).optional(),
    frameRate: z.number().positive().max(120).optional(),
    startTimecode: timecode.optional(),
  }),
  'sessions.archive': z.object({ sessionId: id, archived: z.boolean() }),
  'sessions.delete': z.object({ sessionId: id }),
  'transport.start': z.object({ sessionId: id }),
  'transport.stop': z.object({ sessionId: id }),
  'transport.reset': z.object({ sessionId: id }),

  // ── events ────────────────────────────────────────────────
  'events.list': z.object({
    sessionId: id,
    categoryIds: z.array(id).optional(),
    source: z.enum(['operator', 'companion', 'agent', 'import']).optional(),
  }),
  'events.create': z.object({ sessionId: id, ...EventFields }),
  'events.createMany': z.object({
    sessionId: id,
    events: z.array(z.object(EventFields)).min(1).max(500),
    compact,
  }),
  'events.update': z.object({
    eventId: id,
    categoryId: id.nullable().optional(),
    category: z.string().trim().max(60).optional(),
    message: z.string().max(5000).optional(),
    value: z.string().max(200).nullable().optional(),
    timecode: timecode.optional(),
    atSec: sec.optional(),
  }),
  'events.updateMany': z.object({
    sessionId: id,
    events: z
      .array(
        z.object({
          id,
          categoryId: id.nullable().optional(),
          category: z.string().trim().max(60).optional(),
          message: z.string().max(5000).optional(),
          value: z.string().max(200).nullable().optional(),
          timecode: timecode.optional(),
          atSec: sec.optional(),
        }),
      )
      .min(1)
      .max(500),
    compact,
  }),
  'events.delete': z.object({ eventId: id }),
  'events.importCsv': z.object({ sessionId: id, csv: z.string().max(5_000_000) }),

  // ── transcript ────────────────────────────────────────────
  'transcript.get': z.object({ sessionId: id, fromSec: sec.optional(), toSec: sec.optional() }),
  'transcript.text': z.object({
    sessionId: id,
    fromSec: sec.optional(),
    toSec: sec.optional(),
    format: z.enum(['lines', 'compact']).default('lines'),
    ids: z.boolean().default(false),
  }),
  'transcript.updateSegment': z.object({
    segmentId: id,
    text: z.string().max(20000).optional(),
    speaker: z.string().trim().max(80).optional(),
  }),
  'transcript.find': z
    .object({
      sessionId: id,
      pattern: z.string().min(1).max(500).optional(),
      patterns: z.array(z.string().min(1).max(500)).min(1).max(20).optional(),
      regex: z.boolean().default(false),
      fromSec: sec.optional(),
      toSec: sec.optional(),
      limit: z.number().int().min(1).max(2000).default(500),
      context: z.number().int().min(0).max(3).default(0),
      countOnly: z.boolean().default(false),
      idsOnly: z.boolean().default(false),
    })
    .refine((v) => (v.pattern === undefined) !== (v.patterns === undefined), {
      message: 'Pass exactly one of pattern or patterns',
    })
    .refine((v) => !(v.countOnly && v.idsOnly), {
      message: 'Pass at most one of countOnly or idsOnly',
    }),
  'transcript.updateSegments': z.object({
    sessionId: id,
    updates: z
      .array(
        z.object({
          segmentId: id,
          text: z.string().max(20000).optional(),
          speaker: z.string().trim().max(80).optional(),
        }),
      )
      .min(1)
      .max(500),
    compact,
  }),
  'transcript.renameSpeaker': z
    .object({
      sessionId: id,
      from: z.string().max(80).optional(),
      to: z.string().trim().min(1).max(80),
      fromSec: sec.optional(),
      toSec: sec.optional(),
    })
    .refine((v) => v.from !== undefined || v.fromSec !== undefined || v.toSec !== undefined, {
      message: 'Pass from, or a fromSec/toSec range to relabel every speaker in it',
    })
    .refine((v) => v.fromSec === undefined || v.toSec === undefined || v.fromSec <= v.toSec, {
      message: 'fromSec must not be after toSec',
    }),
  // Segment structure fixes (merge / split).
  'transcript.mergeSegments': z.object({
    segmentIds: z.array(id).min(2).max(50),
    speaker: z.string().trim().max(80).optional(),
  }),
  'transcript.splitSegment': z
    .object({
      segmentId: id,
      atWord: z.number().int().min(1).max(100000).optional(),
      atText: z.string().trim().min(1).max(500).optional(),
      atSec: sec.optional(),
      speaker: z.string().trim().max(80).optional(),
    })
    .refine((v) => [v.atWord, v.atText, v.atSec].filter((x) => x !== undefined).length === 1, {
      message: 'Pass exactly one of atWord, atText or atSec',
    }),
  'transcript.replace': z.object({
    sessionId: id,
    rules: z.array(TranscriptRuleInput).min(1).max(MAX_TRANSCRIPT_RULES).optional(),
    fromSec: sec.optional(),
    toSec: sec.optional(),
    dryRun: z.boolean().default(false),
  }),

  // ── topics ────────────────────────────────────────────────
  'topics.list': z.object({ sessionId: id }),
  'topics.create': z.object({ sessionId: id, ...TopicFields }),
  'topics.update': z.object({
    topicId: id,
    startSec: sec.optional(),
    durationSec: sec.optional(),
    level: z.number().int().min(1).max(3).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    summary: z.string().max(10000).optional(),
  }),
  'topics.delete': z.object({ topicId: id }),
  'topics.replace': z.object({
    sessionId: id,
    topics: z.array(z.object(TopicFields)).max(500),
    compact,
  }),

  // ── dashboards ────────────────────────────────────────────
  'dashboards.list': z.object({ sessionId: id }),
  'dashboards.get': z.object({ dashboardId: id }),
  'dashboards.save': z.object({
    sessionId: id,
    dashboardId: id.optional(),
    spec: DashboardSpec,
    compact,
  }),
  'dashboards.updateWidgets': z.object({
    dashboardId: id,
    /** Widget patches: `id` picks the stored widget, other fields replace its fields (null removes one). */
    widgets: z.array(z.looseObject({ id })).min(1).max(40),
    compact,
  }),
  'dashboards.delete': z.object({ dashboardId: id }),
  'dashboards.query': z.object({ sessionId: id, query: DashboardQuery }),

  // ── wiki ──────────────────────────────────────────────────
  'wiki.list': z.object({
    showId: id,
    kind: z.enum(['person', 'topic', 'bit', 'session']).optional(),
  }),
  'wiki.get': z.object({
    pageId: id.optional(),
    showId: id.optional(),
    title: z.string().optional(),
  }),
  'wiki.upsert': z.object({
    showId: id,
    pageId: id.optional(),
    kind: z.enum(['person', 'topic', 'bit', 'session']),
    title: z.string().trim().min(1).max(200),
    bodyMd: z.string().max(100_000),
    aliases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    sessionId: id.optional(),
  }),
  'wiki.patch': z.object({
    pageId: id,
    edits: z
      .array(z.object({ find: z.string().min(1).max(10_000), replace: z.string().max(100_000) }))
      .max(50)
      .default([]),
    append: z.string().max(100_000).optional(),
  }),
  'wiki.delete': z.object({ pageId: id }),
  'wiki.revisions': z.object({ pageId: id }),
  'wiki.restore': z.object({ pageId: id, revision: z.number().int().min(1) }),

  // ── media ─────────────────────────────────────────────────
  'media.list': z.object({ sessionId: id }),
  'media.createUpload': z.object({
    sessionId: id,
    mimeType: z.string().min(3).max(100),
    origin: z.enum(['recorded', 'file']),
    fileName: z.string().max(300).optional(),
    startSec: sec.optional(),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 ** 3)
      .optional(),
  }),
  'media.completeUpload': z.object({ segmentId: id, durationSec: sec.optional() }),
  'media.playbackUrl': z.object({ segmentId: id }),
  'media.importYoutube': z.object({ sessionId: id, url: z.url() }),
  'media.importPlaylist': z.object({
    showId: id,
    url: z.url().max(2048),
    order: z.enum(['playlist', 'reverse']).default('playlist'),
    titleTemplate: z.string().trim().min(1).max(200).optional(),
    dryRun: z.boolean().default(false),
  }),
  'media.retranscribe': z.object({ sessionId: id, segmentId: id.optional() }),
  'media.delete': z.object({ segmentId: id }),
  'jobs.list': z
    .object({
      sessionId: id.optional(),
      showId: id.optional(),
      status: z
        .array(z.enum(['queued', 'running', 'done', 'failed']))
        .min(1)
        .max(4)
        .optional(),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .refine((v) => (v.sessionId === undefined) !== (v.showId === undefined), {
      message: 'Pass exactly one of sessionId or showId.',
    }),

  // ── search ────────────────────────────────────────────────
  search: z.object({
    query: z.string().trim().min(1).max(200),
    showId: id.optional(),
    sessionId: id.optional(),
    kinds: z.array(z.enum(['event', 'transcript', 'topic', 'wiki', 'session'])).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }),

  // ── change log ────────────────────────────────────────────
  'changes.list': z.object({
    sessionId: id.optional(),
    showId: id.optional(),
    via: z.enum(['web', 'mcp', 'companion', 'worker', 'system']).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  'changes.revert': z.object({ changeId: id }),

  // ── tokens (agents) ───────────────────────────────────────
  'tokens.list': z.object({}),
  'tokens.createPat': z.object({
    name,
    expiresInDays: z.number().int().min(1).max(3650).optional(),
  }),
  'tokens.revoke': z.object({ tokenId: id }),

  // ── companion devices ─────────────────────────────────────
  'companion.list': z.object({ showId: id.optional() }),
  'companion.create': z.object({ showId: id, name }),
  'companion.revoke': z.object({ deviceId: id }),
  'companion.setTarget': z.object({ deviceId: id, sessionId: id.nullable() }),
  /** Companion-socket only: current state for the device. */
  'companion.state': z.object({}),

  // ── instance admin ────────────────────────────────────────
  'admin.users': z.object({}),
  'admin.setStatus': z.object({ userId: id, status: z.enum(['pending', 'active', 'disabled']) }),
  'admin.setSuperadmin': z.object({ userId: id, value: z.boolean() }),
} as const;

export type OpName = keyof typeof opInputs;
export type OpInput<N extends OpName> = z.input<(typeof opInputs)[N]>;
export type OpParsed<N extends OpName> = z.output<(typeof opInputs)[N]>;

export interface CompanionState {
  device: { id: string; name: string };
  show: { id: string; name: string } | null;
  session: Pick<
    Session,
    | 'id'
    | 'title'
    | 'isRolling'
    | 'rollStartedAt'
    | 'elapsedFrames'
    | 'take'
    | 'frameRate'
    | 'startOffsetFrames'
    | 'eventCount'
  > | null;
  categories: Category[];
  lastEvent: Pick<SessionEvent, 'id' | 'category' | 'message' | 'timecodeFrames'> | null;
}

// Compact write acknowledgements, returned instead of the full echo when a bulk write op is
// called with `compact: true` (meant for MCP agents, to save context).
export type CompactEvent = Pick<SessionEvent, 'id' | 'atSec' | 'category'>;
export type CompactTopic = Pick<Topic, 'id' | 'startSec' | 'level' | 'title'>;
export type CompactDashboard = Pick<Dashboard, 'id' | 'revision'>;

export type DashboardRows = Record<string, string | number | boolean | null>[];

export interface PlaylistImport {
  playlistTitle: string | null;
  /** True when nothing was written (dryRun): sessionId and jobId are then null. */
  dryRun: boolean;
  /** One new session per video, in episode order, each with its queued youtube_import job. */
  created: {
    sessionId: string | null;
    title: string;
    episode: string;
    videoId: string;
    durationSec: number | null;
    jobId: string | null;
  }[];
  /** Videos not imported: already in the show (sessionId set) or private/deleted. */
  skipped: {
    videoId: string;
    title: string;
    reason: 'already_imported' | 'unavailable';
    sessionId: string | null;
  }[];
}

export interface OpOutputs {
  'me.get': Me;
  'me.update': Me;
  'teams.list': Team[];
  'teams.get': TeamDetail;
  'teams.create': Team;
  'teams.rename': Team;
  'teams.delete': { deleted: true };
  'teams.invite': TeamDetail;
  'teams.revokeInvite': TeamDetail;
  'teams.setRole': TeamDetail;
  'teams.removeMember': TeamDetail;
  'teams.leave': { left: true };
  'teams.transferOwnership': TeamDetail;
  'teams.setGrant': TeamDetail;
  'shows.list': Show[];
  'shows.get': Show & { categories: Category[] };
  'shows.create': Show;
  'shows.update': Show;
  'shows.delete': { deleted: true };
  'categories.list': Category[];
  'categories.save': Category[];
  'sessions.list': Session[];
  'sessions.get': Session;
  'sessions.create': Session;
  'sessions.update': Session;
  'sessions.archive': Session;
  'sessions.delete': { deleted: true };
  'transport.start': Session;
  'transport.stop': Session;
  'transport.reset': Session;
  'events.list': SessionEvent[];
  'events.create': SessionEvent;
  'events.createMany': SessionEvent[] | CompactEvent[];
  'events.update': SessionEvent;
  'events.updateMany': SessionEvent[] | CompactEvent[];
  'events.delete': { deleted: true };
  'events.importCsv': { imported: number; skipped: { line: number; reason: string }[] };
  'transcript.get': TranscriptSegment[];
  'transcript.text': {
    text: string;
    segments: number;
    /** Characters in `text`. */
    chars: number;
    /** Segments in the whole session, regardless of fromSec/toSec. */
    totalSegments: number;
    /** End of the last segment in the session, seconds from session start. */
    durationSec: number;
  };
  'transcript.updateSegment': TranscriptSegment;
  'transcript.find':
    | { total: number; lines: TranscriptFindLine[] }
    | { total: number; counts: number[] }
    | { total: number; lines: TranscriptFindId[] };
  'transcript.updateSegments':
    | { updated: number; segments: TranscriptLine[] }
    | { updated: number; ids: string[] };
  'transcript.renameSpeaker': { updated: number };
  'transcript.mergeSegments': TranscriptSegment;
  'transcript.splitSegment': TranscriptSegment[];
  'transcript.replace': TranscriptReplaceResult;
  'topics.list': Topic[];
  'topics.create': Topic;
  'topics.update': Topic;
  'topics.delete': { deleted: true };
  'topics.replace': Topic[] | CompactTopic[];
  'dashboards.list': Dashboard[];
  'dashboards.get': Dashboard;
  'dashboards.save': Dashboard | CompactDashboard;
  'dashboards.updateWidgets': Dashboard | CompactDashboard;
  'dashboards.delete': { deleted: true };
  'dashboards.query': DashboardRows;
  'wiki.list': WikiPageSummary[];
  'wiki.get': WikiPage;
  'wiki.upsert': WikiPage;
  // The page summary (WikiPageSummary), spelled via WikiPage so it doesn't depend on that import.
  'wiki.patch': Omit<WikiPage, 'bodyMd' | 'backlinks'>;
  'wiki.delete': { deleted: true };
  'wiki.revisions': WikiRevision[];
  'wiki.restore': WikiPage;
  'media.list': AudioSegment[];
  'media.createUpload': {
    segment: AudioSegment;
    uploadUrl: string;
    headers: Record<string, string>;
  };
  'media.completeUpload': AudioSegment;
  'media.playbackUrl': { url: string; expiresAt: string };
  'media.importYoutube': Job;
  'media.importPlaylist': PlaylistImport;
  'media.retranscribe': Job[];
  'media.delete': { deleted: true };
  'jobs.list': Job[];
  search: SearchHit[];
  'changes.list': Change[];
  'changes.revert': Change;
  'tokens.list': ApiToken[];
  'tokens.createPat': { token: string; apiToken: ApiToken };
  'tokens.revoke': { revoked: true };
  'companion.list': CompanionDevice[];
  'companion.create': { device: CompanionDevice; token: string };
  'companion.revoke': { revoked: true };
  'companion.setTarget': CompanionDevice;
  'companion.state': CompanionState;
  'admin.users': AdminUser[];
  'admin.setStatus': AdminUser;
  'admin.setSuperadmin': AdminUser;
}

// Compile-time check: every op has an output type and vice versa.
type _MissingOutputs = Exclude<OpName, keyof OpOutputs>;
type _ExtraOutputs = Exclude<keyof OpOutputs, OpName>;
const _check: [_MissingOutputs, _ExtraOutputs] extends [never, never] ? true : never = true;
void _check;

export interface RpcError {
  code:
    | 'bad_request'
    | 'unauthenticated'
    | 'forbidden'
    | 'not_found'
    | 'conflict'
    | 'unavailable'
    | 'internal';
  message: string;
  issues?: { path: string; message: string }[];
}

export type RpcResponse<T> = { ok: true; data: T } | { ok: false; error: RpcError };
