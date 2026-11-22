import type { TranscriptRule } from '@autologger/contract';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const created = () => ts('created_at').notNull().defaultNow();

// ── people & access ─────────────────────────────────────────

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  googleSub: text('google_sub').unique(),
  name: text('name').notNull().default(''),
  pictureUrl: text('picture_url'),
  status: text('status', { enum: ['pending', 'active', 'disabled'] })
    .notNull()
    .default('pending'),
  isSuperadmin: boolean('is_superadmin').notNull().default(false),
  createdAt: created(),
  lastLoginAt: ts('last_login_at'),
});

export const authSessions = pgTable(
  'auth_sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: created(),
    expiresAt: ts('expires_at').notNull(),
    userAgent: text('user_agent'),
  },
  (t) => [index('auth_sessions_user').on(t.userId)],
);

export const teams = pgTable('teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: created(),
});

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
    joinedAt: ts('joined_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    uniqueIndex('team_one_owner').on(t.teamId).where(sql`role = 'owner'`),
    index('team_members_user').on(t.userId),
  ],
);

export const teamInvites = pgTable(
  'team_invites',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    invitedBy: text('invited_by').references(() => users.id, { onDelete: 'set null' }),
    invitedAt: ts('invited_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.email] }), index('team_invites_email').on(t.email)],
);

// ── shows ───────────────────────────────────────────────────

export const shows = pgTable(
  'shows',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: text('code').notNull(),
    nextEpisode: integer('next_episode').notNull().default(1),
    defaultFrameRate: doublePrecision('default_frame_rate').notNull().default(24),
    titleSuffix: text('title_suffix', { enum: ['date', 'episode', 'none'] })
      .notNull()
      .default('date'),
    /** Deepgram `smart_format` for this show's transcription jobs. */
    smartFormat: boolean('smart_format').notNull().default(true),
    /** Deepgram keyterm prompting (nova-3): terms the transcriber should favour. */
    keyTerms: text('key_terms').array().notNull().default(sql`'{}'::text[]`),
    /** Find/replace rules applied, in order, to every new transcription of this show. */
    transcriptRules: jsonb('transcript_rules').$type<TranscriptRule[]>().notNull().default([]),
    createdAt: created(),
  },
  (t) => [index('shows_team').on(t.teamId)],
);

export const showGrants = pgTable(
  'show_grants',
  {
    showId: text('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    canWrite: boolean('can_write').notNull().default(true),
    grantedBy: text('granted_by').references(() => users.id, { onDelete: 'set null' }),
    grantedAt: ts('granted_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.showId, t.userId] }), index('show_grants_user').on(t.userId)],
);

export const categories = pgTable(
  'categories',
  {
    id: text('id').primaryKey(),
    showId: text('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    kind: text('kind', { enum: ['button', 'dropdown', 'text', 'toggle'] }).notNull(),
    options: jsonb('options').$type<string[]>().notNull().default([]),
    onLabel: text('on_label').notNull().default('ON'),
    offLabel: text('off_label').notNull().default('OFF'),
    createdAt: created(),
  },
  (t) => [index('categories_show').on(t.showId, t.position)],
);

// ── sessions & content ──────────────────────────────────────

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    showId: text('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    episode: text('episode').notNull().default(''),
    episodeDate: date('episode_date', { mode: 'string' }),
    notes: text('notes').notNull().default(''),
    frameRate: doublePrecision('frame_rate').notNull(),
    startOffsetFrames: bigint('start_offset_frames', { mode: 'number' }).notNull().default(0),
    isRolling: boolean('is_rolling').notNull().default(false),
    rollStartedAt: ts('roll_started_at'),
    elapsedFrames: bigint('elapsed_frames', { mode: 'number' }).notNull().default(0),
    take: integer('take').notNull().default(0),
    sourceKind: text('source_kind', { enum: ['recorded', 'file', 'youtube'] }),
    sourceUrl: text('source_url'),
    keyTerms: text('key_terms').array().notNull().default(sql`'{}'::text[]`),
    archivedAt: ts('archived_at'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(episode,'') || ' ' || coalesce(notes,''))`,
    ),
  },
  (t) => [
    index('sessions_show').on(t.showId, t.createdAt),
    index('sessions_search').using('gin', t.search),
  ],
);

export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
    category: text('category').notNull(),
    color: text('color').notNull(),
    message: text('message').notNull().default(''),
    value: text('value'),
    timecodeFrames: bigint('timecode_frames', { mode: 'number' }),
    wallTime: ts('wall_time').notNull().defaultNow(),
    take: integer('take').notNull().default(0),
    source: text('source', { enum: ['operator', 'companion', 'agent', 'import'] }).notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(category,'') || ' ' || coalesce(message,'') || ' ' || coalesce(value,''))`,
    ),
  },
  (t) => [
    index('events_session').on(t.sessionId, t.timecodeFrames),
    index('events_search').using('gin', t.search),
  ],
);

export const audioSegments = pgTable(
  'audio_segments',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    startSec: doublePrecision('start_sec').notNull().default(0),
    durationSec: doublePrecision('duration_sec'),
    mimeType: text('mime_type').notNull(),
    origin: text('origin', { enum: ['recorded', 'file', 'youtube'] }).notNull(),
    fileName: text('file_name'),
    objectKey: text('object_key').notNull(),
    /** S3 key of the waveform peaks object (worker `waveform` job); null until computed. */
    peaksKey: text('peaks_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    status: text('status', {
      enum: ['uploading', 'ready', 'transcribing', 'transcribed', 'failed'],
    })
      .notNull()
      .default('uploading'),
    error: text('error'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [index('audio_segments_session').on(t.sessionId, t.ordinal)],
);

export const transcriptSegments = pgTable(
  'transcript_segments',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    audioSegmentId: text('audio_segment_id').references(() => audioSegments.id, {
      onDelete: 'cascade',
    }),
    startSec: doublePrecision('start_sec').notNull(),
    endSec: doublePrecision('end_sec').notNull(),
    speaker: text('speaker').notNull().default(''),
    text: text('text').notNull(),
    words: jsonb('words')
      .$type<{ w: string; s: number; e: number; sp?: number }[]>()
      .notNull()
      .default([]),
    edited: boolean('edited').notNull().default(false),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    search: tsvector('search').generatedAlwaysAs(sql`to_tsvector('english', coalesce(text,''))`),
  },
  (t) => [
    index('transcript_session').on(t.sessionId, t.startSec),
    index('transcript_search').using('gin', t.search),
  ],
);

const viaEnum = ['web', 'mcp', 'companion', 'worker', 'system'] as const;

export const topics = pgTable(
  'topics',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    startSec: doublePrecision('start_sec').notNull(),
    durationSec: doublePrecision('duration_sec').notNull().default(0),
    level: integer('level').notNull().default(1),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    via: text('via', { enum: viaEnum }).notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,''))`,
    ),
  },
  (t) => [
    index('topics_session').on(t.sessionId, t.startSec),
    index('topics_search').using('gin', t.search),
  ],
);

export const dashboards = pgTable(
  'dashboards',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    spec: jsonb('spec').notNull(),
    revision: integer('revision').notNull().default(1),
    via: text('via', { enum: viaEnum }).notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('dashboards_session').on(t.sessionId)],
);

export const wikiPages = pgTable(
  'wiki_pages',
  {
    id: text('id').primaryKey(),
    showId: text('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['person', 'topic', 'bit', 'session', 'question'] }).notNull(),
    title: text('title').notNull(),
    titleNorm: text('title_norm').notNull(),
    bodyMd: text('body_md').notNull().default(''),
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    revision: integer('revision').notNull().default(1),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    /** Soft delete: the page and its revisions stay so the deletion can be undone. */
    deletedAt: ts('deleted_at'),
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body_md,''))`,
    ),
  },
  (t) => [
    // Titles are unique among live pages only, so a deleted page's title can be reused.
    uniqueIndex('wiki_pages_title').on(t.showId, t.titleNorm).where(sql`deleted_at is null`),
    index('wiki_pages_search').using('gin', t.search),
  ],
);

export const wikiRevisions = pgTable(
  'wiki_revisions',
  {
    pageId: text('page_id')
      .notNull()
      .references(() => wikiPages.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    title: text('title').notNull(),
    kind: text('kind').notNull(),
    bodyMd: text('body_md').notNull(),
    aliases: jsonb('aliases').$type<string[]>().notNull(),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    via: text('via', { enum: viaEnum }).notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.revision] })],
);

/**
 * Link index: the distinct [[link]] targets of each page's current body (wikiLinkTargets), kept in
 * step with every body write and undo. Targets are stored normalised, not as page ids, and resolve
 * to pages through titles and aliases at read time, so renames and new aliases need no reindex.
 * Rows of a soft-deleted page stay (undo brings them back); readers join live pages.
 */
export const wikiLinks = pgTable(
  'wiki_links',
  {
    fromPageId: text('from_page_id')
      .notNull()
      .references(() => wikiPages.id, { onDelete: 'cascade' }),
    /** normTitle(target): what titles and aliases are matched against. */
    targetNorm: text('target_norm').notNull(),
    /** The target as first written in the body (wiki.lint reports it). */
    target: text('target').notNull(),
    /** Order of first appearance in the body. */
    ord: integer('ord').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fromPageId, t.targetNorm] }),
    index('wiki_links_target').on(t.targetNorm),
  ],
);

/**
 * Citation index: the session citations of each page's current body (wikiCitations, repeats kept),
 * kept in step with every body write and undo like wiki_links. sessionId is as written, not a
 * foreign key: a citation may name a session that is gone or in another show (wiki.lint reports
 * it). Rows of a soft-deleted page stay; readers join live pages.
 */
export const wikiCitations = pgTable(
  'wiki_citations',
  {
    fromPageId: text('from_page_id')
      .notNull()
      .references(() => wikiPages.id, { onDelete: 'cascade' }),
    /** Order in the body. */
    ord: integer('ord').notNull(),
    sessionId: text('session_id').notNull(),
    /** Seconds from the session start (`t`). */
    startSec: doublePrecision('start_sec').notNull(),
    /** `to` as written (may be <= startSec; wiki.lint flags it), null without one. */
    endSec: doublePrecision('end_sec'),
    label: text('label').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fromPageId, t.ord] }),
    index('wiki_citations_session').on(t.sessionId),
  ],
);

// ── audit / undo ────────────────────────────────────────────

export const changes = pgTable(
  'changes',
  {
    id: text('id').primaryKey(),
    at: ts('at').notNull().defaultNow(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    via: text('via', { enum: viaEnum }).notNull(),
    clientName: text('client_name'),
    tokenId: text('token_id'),
    op: text('op').notNull(),
    entity: text('entity', {
      enum: [
        'event',
        'topic',
        'transcript_segment',
        'dashboard',
        'wiki_page',
        'category',
        'session',
      ],
    }).notNull(),
    entityId: text('entity_id').notNull(),
    kind: text('kind', { enum: ['create', 'update', 'delete'] }).notNull(),
    summary: text('summary').notNull(),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    showId: text('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    before: jsonb('before'),
    after: jsonb('after'),
    revertedAt: ts('reverted_at'),
    revertOf: text('revert_of'),
    /** Shared by every change one op call wrote (null on rows from before groups existed). */
    groupId: text('group_id'),
  },
  (t) => [
    index('changes_session').on(t.sessionId, t.at),
    index('changes_show').on(t.showId, t.at),
    index('changes_entity').on(t.entity, t.entityId, t.at),
    index('changes_group').on(t.groupId),
  ],
);

// ── agent & device credentials ──────────────────────────────

export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: created(),
});

/** An /oauth/authorize request waiting for the signed-in user's consent in the SPA. */
export const oauthRequests = pgTable('oauth_requests', {
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  state: text('state'),
  scope: text('scope').notNull().default(''),
  resource: text('resource'),
  createdAt: created(),
  expiresAt: ts('expires_at').notNull(),
});

export const oauthCodes = pgTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scope: text('scope').notNull().default(''),
  resource: text('resource'),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['pat', 'oauth_access', 'oauth_refresh'] }).notNull(),
    name: text('name').notNull(),
    clientId: text('client_id').references(() => oauthClients.id, { onDelete: 'cascade' }),
    /** Groups an OAuth grant's access + refresh tokens so revoking one revokes all. */
    grantId: text('grant_id'),
    tokenHash: text('token_hash').notNull().unique(),
    prefix: text('prefix').notNull(),
    scope: text('scope').notNull().default(''),
    createdAt: created(),
    lastUsedAt: ts('last_used_at'),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('api_tokens_user').on(t.userId), index('api_tokens_grant').on(t.grantId)],
);

export const companionDevices = pgTable(
  'companion_devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    showId: text('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    prefix: text('prefix').notNull(),
    targetSessionId: text('target_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    createdAt: created(),
    lastSeenAt: ts('last_seen_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('companion_devices_show').on(t.showId)],
);

// ── background jobs ─────────────────────────────────────────

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['transcribe', 'youtube_import', 'waveform'] }).notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] })
      .notNull()
      .default('queued'),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull().default({}),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    error: text('error'),
    progress: text('progress'),
    attempts: integer('attempts').notNull().default(0),
    runAfter: ts('run_after').notNull().defaultNow(),
    lockedAt: ts('locked_at'),
    /** When the current (or last) attempt was claimed; cleared when the job is requeued. */
    startedAt: ts('started_at'),
    /** Failed jobs only: when someone acknowledged the failure (jobs.dismiss). */
    dismissedAt: ts('dismissed_at'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('jobs_queue').on(t.status, t.runAfter),
    index('jobs_session').on(t.sessionId, t.createdAt),
    // Recent finished jobs per kind (duration estimates in jobs.list).
    index('jobs_finished').on(t.kind, t.status, t.updatedAt),
  ],
);

/**
 * Running worker processes (heartbeat). Each worker inserts its row on start, bumps last_seen_at
 * every WORKER_HEARTBEAT_SEC and deletes it on clean shutdown; rows not seen for
 * WORKER_STALE_SEC are ignored (jobs.list etaSec sums the live ones' concurrency).
 */
export const workers = pgTable('workers', {
  id: text('id').primaryKey(),
  concurrency: integer('concurrency').notNull(),
  /** Per job kind slot caps (WORKER_CONCURRENCY_<KIND>). */
  kindConcurrency: jsonb('kind_concurrency').notNull().default({}),
  startedAt: ts('started_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
});
