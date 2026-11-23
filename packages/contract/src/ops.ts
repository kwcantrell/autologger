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
  CompactMomentSearch,
  CompanionDevice,
  Compilation,
  Dashboard,
  GraphEntity,
  GraphExportJsonLd,
  GraphExportRows,
  Job,
  Me,
  MomentSearch,
  SearchHit,
  SegmentWaveform,
  Session,
  SessionDetail,
  SessionEvent,
  Show,
  Team,
  TeamDetail,
  Topic,
  TranscriptFindId,
  TranscriptFindLine,
  TranscriptLine,
  TranscriptReplaceCompactResult,
  TranscriptReplaceResult,
  TranscriptSegment,
  WikiLint,
  WikiList,
  WikiPage,
  WikiRevision,
  WikiSavedCitations,
  YoutubeAccess,
} from './entities.ts';
import { MAX_TRANSCRIPT_RULES, TranscriptRuleInput } from './transcriptRules.ts';

/** An entity id (ses_…, evt_…). */
export const EntityId = z.string().min(1).max(64);
const id = EntityId;
const name = z.string().trim().min(1).max(200);

/** Show transcription key terms (Deepgram keyterm prompting caps a request at ~500 tokens). */
/** Largest cookies.txt accepted by media.setYoutubeCookies (before filtering to YouTube/Google). */
export const MAX_YOUTUBE_COOKIES_CHARS = 1_000_000;
/** transcript.import limits: content characters and segments per call. */
export const MAX_TRANSCRIPT_IMPORT_CHARS = 5_000_000;
export const MAX_TRANSCRIPT_IMPORT_SEGMENTS = 10_000;
export const MAX_KEY_TERMS = 50;
export const MAX_KEY_TERM_LENGTH = 50;
/** Budget for all key terms together (trimmed characters), keeping a request under ~500 tokens. */
export const MAX_KEY_TERMS_TOTAL_CHARS = 1000;
/** Characters a key term list spends of MAX_KEY_TERMS_TOTAL_CHARS. */
export const keyTermsChars = (terms: string[]): number =>
  terms.reduce((n, t) => n + t.trim().length, 0);
/** A key term list for one session or one re-transcription (same limits as the show's list). */
const keyTermList = z
  .array(z.string().trim().min(1).max(MAX_KEY_TERM_LENGTH))
  .max(MAX_KEY_TERMS)
  .refine((terms) => keyTermsChars(terms) <= MAX_KEY_TERMS_TOTAL_CHARS, {
    message: `Key terms may total at most ${MAX_KEY_TERMS_TOTAL_CHARS} characters (Deepgram limits key terms to about 500 tokens per request).`,
  });
const teamRole = z.enum(['owner', 'admin', 'member']);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const sec = z
  .number()
  .min(0)
  .max(7 * 24 * 3600);
/** Compilation limits (compilations.create). */
export const MIN_CLIP_SEC = 1;
export const MAX_CLIP_SEC = 20 * 60;
export const MAX_COMPILATION_CLIPS = 100;
export const MAX_COMPILATION_SEC = 3 * 3600;
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

/** `compact: true`: a small acknowledgement / listing instead of full entities (see CompactOpOutputs). */
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
  'media.youtubeAccess': z
    .object({ teamId: id.optional(), showId: id.optional() })
    .refine((v) => (v.teamId === undefined) !== (v.showId === undefined), {
      message: 'Pass exactly one of teamId or showId.',
    }),
  'media.setYoutubeCookies': z
    .object({
      teamId: id.optional(),
      showId: id.optional(),
      /** Netscape cookies.txt or JSON cookie export; null removes the team's cookies. */
      cookies: z.string().max(MAX_YOUTUBE_COOKIES_CHARS).nullable(),
    })
    .refine((v) => (v.teamId === undefined) !== (v.showId === undefined), {
      message: 'Pass exactly one of teamId or showId.',
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
    keyTerms: keyTermList.optional(),
  }),
  'sessions.update': z.object({
    sessionId: id,
    title: z.string().trim().max(200).optional(),
    episode: z.string().trim().max(40).optional(),
    episodeDate: z.iso.date().nullable().optional(),
    notes: z.string().max(10000).optional(),
    frameRate: z.number().positive().max(120).optional(),
    startTimecode: timecode.optional(),
    /** How logged events follow a frame rate / start timecode change (default keep_seconds). */
    retime: z.enum(['keep_seconds', 'keep_frames']).optional(),
    keyTerms: keyTermList.optional(),
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
    compact,
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
    /** compact only: seconds between inline `[@…]` stamps; 0 stamps every segment. */
    stampEverySec: z.number().min(0).max(3600).default(60),
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
      /** Instead of a pattern: turns likely to hold two speakers (see SUSPECT_TURN_REASONS). */
      suspect: z.boolean().default(false),
    })
    .refine(
      (v) =>
        [v.pattern !== undefined, v.patterns !== undefined, v.suspect].filter(Boolean).length === 1,
      { message: 'Pass exactly one of pattern, patterns or suspect: true' },
    )
    .refine((v) => !(v.suspect && v.regex), {
      message: 'regex applies to pattern or patterns, not to suspect',
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
    compact,
  }),
  'transcript.import': z.object({
    sessionId: id,
    /** Audio segment (media.list) the transcript belongs to; omitted: session-level. */
    audioSegmentId: id.optional(),
    format: z.enum(['json', 'srt', 'vtt']),
    content: z.string().min(1).max(MAX_TRANSCRIPT_IMPORT_CHARS),
    mode: z.enum(['replace', 'append']),
  }),

  // ── topics ────────────────────────────────────────────────
  'topics.list': z.object({ sessionId: id, compact }),
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
    kind: z.enum(['person', 'topic', 'bit', 'session', 'question']).optional(),
    include: z.enum(['summary', 'body']).optional(),
    linksTo: id.optional(),
    citesSession: id.optional(),
    /** With citesSession: per-page `citationCount` instead of the `citations` ranges. */
    countOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  'wiki.get': z.object({
    pageId: id.optional(),
    showId: id.optional(),
    title: z.string().optional(),
  }),
  'wiki.upsert': z.object({
    showId: id,
    pageId: id.optional(),
    kind: z.enum(['person', 'topic', 'bit', 'session', 'question']),
    title: z.string().trim().min(1).max(200),
    bodyMd: z.string().max(100_000),
    aliases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    sessionId: id.optional(),
    /** The revision the edit started from; a page that moved on since fails with conflict. */
    baseRevision: z.number().int().min(1).optional(),
    compact,
  }),
  'wiki.patch': z.object({
    pageId: id,
    edits: z
      .array(z.object({ find: z.string().min(1).max(10_000), replace: z.string().max(100_000) }))
      .max(50)
      .default([]),
    append: z.string().max(100_000).optional(),
    /** The revision the edit started from; a page that moved on since fails with conflict. */
    baseRevision: z.number().int().min(1).optional(),
    compact,
  }),
  'wiki.delete': z.object({ pageId: id }),
  'wiki.revisions': z.object({ pageId: id }),
  'wiki.restore': z.object({ pageId: id, revision: z.number().int().min(1) }),
  'wiki.lint': z.object({ showId: id }),

  // ── media ─────────────────────────────────────────────────
  'media.list': z.object({ sessionId: id }),
  'media.createUpload': z
    .object({
      sessionId: id,
      mimeType: z.string().min(3).max(100),
      origin: z.enum(['recorded', 'file', 'youtube']),
      fileName: z.string().max(300).optional(),
      startSec: sec.optional(),
      sizeBytes: z
        .number()
        .int()
        .positive()
        .max(5 * 1024 ** 3)
        .optional(),
      /** origin "youtube" only: the video the client downloaded itself (local import helper). */
      youtube: z
        .object({
          url: z.url().max(2048),
          title: z.string().trim().min(1).max(300).optional(),
          uploadDate: z.iso.date().optional(),
          private: z.boolean().default(false),
        })
        .optional(),
    })
    .refine((v) => (v.origin === 'youtube') === (v.youtube !== undefined), {
      message: 'Pass youtube {url, …} exactly when origin is "youtube".',
    }),
  'media.completeUpload': z.object({
    segmentId: id,
    durationSec: sec.optional(),
    /** false: store the audio and draw its waveform, no transcription. */
    transcribe: z.boolean().default(true),
  }),
  'media.completeUploads': z.object({
    segmentIds: z.array(id).min(1).max(200),
    transcribe: z.boolean().default(true),
  }),
  'media.importFiles': z.object({
    showId: id,
    files: z
      .array(
        z.object({
          /** The file's name (with extension); with sizeBytes it identifies the file on re-runs. */
          fileName: z.string().trim().min(1).max(300),
          sizeBytes: z
            .number()
            .int()
            .positive()
            .max(5 * 1024 ** 3),
          mimeType: z.string().min(3).max(100),
          title: z.string().trim().max(200).optional(),
          episode: z.string().trim().max(40).optional(),
          episodeDate: z.iso.date().optional(),
          notes: z.string().max(10000).optional(),
          keyTerms: keyTermList.optional(),
        }),
      )
      .min(1)
      .max(100),
    dryRun: z.boolean().default(false),
  }),
  'media.playbackUrl': z.object({ segmentId: id }),
  'media.waveform': z.object({ sessionId: id }),
  'media.importYoutube': z.object({
    sessionId: id,
    url: z.url(),
    /** false: download only (audio + waveform), no transcription. */
    transcribe: z.boolean().default(true),
  }),
  'media.importPlaylist': z
    .object({
      showId: id,
      url: z.url().max(2048).optional(),
      /** Instead of url: videos the client listed itself (local import helper); no server download. */
      videos: z
        .array(
          z.object({
            url: z.url().max(2048),
            title: z.string().trim().min(1).max(500),
            durationSec: sec.nullable().optional(),
            uploadDate: z.iso.date().optional(),
          }),
        )
        .min(1)
        .max(200)
        .optional(),
      order: z.enum(['playlist', 'reverse']).default('playlist'),
      titleTemplate: z.string().trim().min(1).max(200).optional(),
      dryRun: z.boolean().default(false),
      /** false: download only (audio + waveform), no transcription. */
      transcribe: z.boolean().default(true),
      /** Per-video session key terms, by YouTube video id; set before any job is queued. */
      keyTerms: z
        .record(z.string().regex(/^[A-Za-z0-9_-]{11}$/, 'a YouTube video id'), keyTermList)
        .refine((m) => Object.keys(m).length <= 200, { message: 'At most 200 videos.' })
        .optional(),
    })
    .refine((v) => (v.url === undefined) !== (v.videos === undefined), {
      message: 'Pass exactly one of url or videos.',
    }),
  'media.retranscribe': z.object({
    sessionId: id,
    segmentId: id.optional(),
    keyTerms: keyTermList.optional(),
  }),
  'media.rewaveform': z.object({ sessionId: id, segmentId: id.optional() }),
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
      kinds: z
        .array(z.enum(['transcribe', 'youtube_import', 'waveform', 'compile']))
        .min(1)
        .max(4)
        .optional(),
      limit: z.number().int().min(1).max(500).default(100),
      waitSec: z.number().int().min(1).max(55).optional(),
      hideDismissed: z.boolean().default(false),
    })
    .refine((v) => (v.sessionId === undefined) !== (v.showId === undefined), {
      message: 'Pass exactly one of sessionId or showId.',
    }),
  'jobs.dismiss': z.object({ jobId: id }),

  // ── compilations ──────────────────────────────────────────
  'compilations.create': z.object({
    showId: id,
    title: name,
    clips: z
      .array(
        z
          .object({
            sessionId: id,
            startSec: sec,
            endSec: sec,
            label: z.string().trim().min(1).max(200).optional(),
          })
          .refine((c) => c.endSec - c.startSec >= MIN_CLIP_SEC, {
            message: `Each clip must be at least ${MIN_CLIP_SEC} s long (endSec > startSec).`,
          })
          .refine((c) => c.endSec - c.startSec <= MAX_CLIP_SEC, {
            message: `Each clip may be at most ${MAX_CLIP_SEC / 60} minutes long.`,
          }),
      )
      .min(1)
      .max(MAX_COMPILATION_CLIPS)
      .refine((cs) => cs.reduce((n, c) => n + c.endSec - c.startSec, 0) <= MAX_COMPILATION_SEC, {
        message: `The clips may total at most ${MAX_COMPILATION_SEC / 3600} hours.`,
      }),
    logEvents: z.boolean().default(true),
    buildLocally: z.boolean().default(false),
  }),
  'compilations.get': z.object({
    compilationId: id,
    // ≤ 55 like jobs.list: MCP clients time out requests at about 60 s.
    waitSec: z.number().int().min(0).max(55).optional(),
  }),
  'compilations.list': z.object({ showId: id }),
  'compilations.delete': z.object({ compilationId: id }),
  'compilations.retry': z.object({ compilationId: id, buildLocally: z.boolean().default(false) }),
  'compilations.createUpload': z.object({
    compilationId: id,
    /** The MP4's size: over 32 MiB it is uploaded in parts. */
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 ** 3)
      .optional(),
  }),
  'compilations.completeUpload': z.object({ compilationId: id, durationSec: sec.optional() }),

  // ── search ────────────────────────────────────────────────
  search: z.object({
    query: z.string().trim().min(1).max(200),
    showId: id.optional(),
    sessionId: id.optional(),
    kinds: z.array(z.enum(['event', 'transcript', 'topic', 'wiki', 'session'])).optional(),
    limit: z.number().int().min(1).max(500).default(30),
    /** Hits to skip, for the next page: pass the number of hits already read. */
    offset: z.number().int().min(0).max(10000).default(0),
  }),

  // ── knowledge graph ───────────────────────────────────────
  'moments.search': z
    .object({
      showId: id,
      /** Full-text query (websearch syntax). Optional when `entities` is given. */
      query: z.string().trim().min(1).max(200).optional(),
      /** Page titles, aliases or page ids; a moment must be about all of them. */
      entities: z.array(z.string().trim().min(1).max(200)).min(1).max(10).optional(),
      sessionId: id.optional(),
      kinds: z
        .array(z.enum(['citation', 'topic', 'event', 'transcript']))
        .min(1)
        .optional(),
      limit: z.number().int().min(1).max(500).default(30),
      offset: z.number().int().min(0).max(100000).default(0),
      /** > 0: also merge this page's moments per session into clip ranges when gaps are at most this many seconds. */
      mergeGapSec: z.number().min(0).max(600).default(0),
      /** Length given to moments without an end (events, open citations) when merging into clips. */
      pointSec: z.number().min(1).max(600).default(30),
      /**
       * Longest clip merging may build. Moments longer than this (e.g. a whole-segment topic) are
       * left out of clips when tighter moments cover them, and merging starts a new clip rather
       * than grow one past it.
       */
      maxClipSec: z.number().min(10).max(1200).default(180),
      /** With mergeGapSec: return only the clips (moments: []). */
      clipsOnly: z.boolean().default(false),
      compact,
    })
    .refine((v) => v.query || v.entities, { message: 'Pass query, entities or both.' }),
  'graph.entity': z.object({
    showId: id,
    /** Page title, alias or page id. */
    entity: z.string().trim().min(1).max(200),
    /** Max related pages returned. */
    relatedLimit: z.number().int().min(0).max(200).default(25),
  }),
  'graph.export': z.object({
    showId: id,
    /** "jsonl": property-graph rows (nodes, edges, moments, chunks), paged. "jsonld": one schema.org JSON-LD document. */
    format: z.enum(['jsonl', 'jsonld']).default('jsonl'),
    /** jsonl only: which rows. "chunks" are wiki sections ready for a vector index. */
    section: z.enum(['all', 'nodes', 'edges', 'moments', 'chunks']).default('all'),
    /** Rows per page; the file downloads take everything in one call. */
    limit: z.number().int().min(1).max(1000000).default(500),
    offset: z.number().int().min(0).max(1000000).default(0),
  }),

  // ── change log ────────────────────────────────────────────
  'changes.list': z
    .object({
      /** null: only show-level changes (wiki pages, event buttons), which belong to no session. */
      sessionId: id.nullable().optional(),
      showId: id.optional(),
      /** One surface or a list of them (any of). */
      via: z
        .union([
          z.enum(['web', 'mcp', 'companion', 'worker', 'system']),
          z
            .array(z.enum(['web', 'mcp', 'companion', 'worker', 'system']))
            .min(1)
            .max(5),
        ])
        .optional(),
      /** Only changes by this MCP client or Companion device (Change.clientName, e.g. "claude-code"). */
      clientName: z.string().min(1).max(200).optional(),
      /** Only changes to this kind of item. */
      entity: z
        .enum([
          'event',
          'topic',
          'transcript_segment',
          'dashboard',
          'wiki_page',
          'category',
          'session',
          'audio_segment',
        ])
        .optional(),
      groupId: id.optional(),
      grouped: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .refine((v) => !v.grouped || typeof v.sessionId === 'string' || v.showId !== undefined, {
      message: 'grouped: true needs a sessionId or showId.',
    }),
  'changes.revert': z.object({ changeId: id }),
  'changes.revertGroup': z.object({ groupId: id }),

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
/**
 * Compact acknowledgement of events.createMany / events.updateMany: the event ids in input order,
 * and the items whose button name matched no button of the show and so became a free label.
 */
export interface CompactEventsAck {
  ids: string[];
  /**
   * One entry per unmatched name (as sent, trimmed) with the input `indexes` that used it, in
   * input order. Empty when every name matched a button.
   */
  freeLabels: { category: string; indexes: number[] }[];
}
export type CompactTopic = Pick<Topic, 'id' | 'startSec' | 'level' | 'title'>;
export type CompactDashboard = Pick<Dashboard, 'id' | 'revision'>;
// Compact read / write results for the ops agents call most on long sessions.
export type CompactEventLine = Pick<SessionEvent, 'id' | 'atSec' | 'category' | 'message'>;
export type CompactTopicLine = Pick<
  Topic,
  'id' | 'startSec' | 'durationSec' | 'level' | 'title' | 'summary'
>;
export type CompactWikiPage = Pick<WikiPage, 'id' | 'title' | 'kind' | 'revision'> & {
  /** [[link]] targets in the body that match no page title or alias in the show. */
  unresolvedLinks: string[];
} & WikiSavedCitations;

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
  /**
   * Whether YouTube lets the server download the first video (a metadata read): blocked = the
   * bot check or a sign-in wall (a real call then fails instead), skipped = not checked.
   */
  downloadCheck: { status: 'ok' | 'blocked' | 'skipped'; message: string };
}

/** One part of a multipart upload: PUT bytes [offset, offset + sizeBytes) of the file to url. */
export interface UploadPart {
  partNumber: number;
  offset: number;
  sizeBytes: number;
  /** Presigned PUT; absent when the part is already stored (`uploaded`). */
  url?: string;
  /** Stored by an earlier attempt: skip it. */
  uploaded?: true;
}

/**
 * Where to PUT a file: `uploadUrl` (one PUT with exactly `headers`) for files up to 32 MiB or of
 * unknown size, else `parts` (one PUT per part, no headers needed). The server assembles the
 * parts when the upload is completed.
 */
export interface UploadTarget {
  uploadUrl?: string;
  headers: Record<string, string>;
  parts?: UploadPart[];
  /** When the URLs stop working (ISO time). */
  expiresAt: string;
}

/** compilations.createUpload: what the local import helper downloads, and where it PUTs the MP4. */
export interface CompilationUpload extends UploadTarget {
  compilation: Compilation;
  /** One per clip, in play order: the YouTube video and the range in VIDEO seconds to cut. */
  sources: { sessionId: string; url: string; fromSec: number; toSec: number }[];
}

/** media.importFiles: one entry per file, in input order. */
export interface FileImport {
  dryRun: boolean;
  files: {
    fileName: string;
    /** created: new session; resumed: its earlier upload never finished; skipped: already uploaded. */
    status: 'created' | 'resumed' | 'skipped';
    sessionId: string | null;
    segmentId: string | null;
    title: string;
    episode: string | null;
    /** created / resumed (not in a dry run): where to PUT the file. */
    upload?: UploadTarget;
  }[];
}

/** media.completeUploads: the segments completed, and those whose bytes are not all stored yet. */
export interface UploadsCompleted {
  completed: AudioSegment[];
  pending: { segmentId: string; message: string; missingParts?: number[] }[];
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
  'shows.get': Show & {
    categories: Category[];
    /** Distinct clientName of the MCP clients that changed this show (changes.list filter). */
    mcpClients: string[];
    /** Distinct clientName (device name) of the Companion devices that changed this show. */
    companionDevices: string[];
  };
  'shows.create': Show;
  'shows.update': Show;
  'media.youtubeAccess': YoutubeAccess;
  'media.setYoutubeCookies': YoutubeAccess & {
    /** Result of a test read of a public video with the new cookies; null when not run. */
    check: { ok: boolean; message: string } | null;
  };
  'shows.delete': { deleted: true };
  'categories.list': Category[];
  'categories.save': Category[];
  'sessions.list': Session[];
  'sessions.get': SessionDetail;
  'sessions.create': Session;
  'sessions.update': Session;
  'sessions.archive': Session;
  'sessions.delete': { deleted: true };
  'transport.start': Session;
  'transport.stop': Session;
  'transport.reset': Session;
  'events.list': SessionEvent[];
  'events.create': SessionEvent;
  'events.createMany': SessionEvent[];
  'events.update': SessionEvent;
  'events.updateMany': SessionEvent[];
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
    /** As Session.transcriptStatus: done with 0 totalSegments means no speech was found. */
    transcriptStatus: Session['transcriptStatus'];
  };
  'transcript.updateSegment': TranscriptSegment;
  'transcript.find':
    | { total: number; lines: TranscriptFindLine[] }
    | { total: number; counts: number[] }
    | { total: number; lines: TranscriptFindId[] };
  'transcript.updateSegments': { updated: number; segments: TranscriptLine[] };
  'transcript.renameSpeaker': { updated: number };
  'transcript.mergeSegments': TranscriptSegment;
  'transcript.splitSegment': TranscriptSegment[];
  'transcript.replace': TranscriptReplaceResult;
  'transcript.import': {
    mode: 'replace' | 'append';
    /** Segments created. */
    imported: number;
    /** Segments deleted (replace mode). */
    removed: number;
    /** Seconds from session start spanned by the imported segments. */
    startSec: number;
    endSec: number;
    speakers: string[];
    /** changes.revertGroup(groupId) undoes the whole import. */
    groupId: string;
    transcriptStatus: Session['transcriptStatus'];
  };
  'topics.list': Topic[];
  'topics.create': Topic;
  'topics.update': Topic;
  'topics.delete': { deleted: true };
  'topics.replace': Topic[];
  'dashboards.list': Dashboard[];
  'dashboards.get': Dashboard;
  'dashboards.save': Dashboard;
  'dashboards.updateWidgets': Dashboard;
  'dashboards.delete': { deleted: true };
  'dashboards.query': DashboardRows;
  'wiki.list': WikiList;
  'wiki.get': WikiPage;
  'wiki.upsert': WikiPage & WikiSavedCitations;
  // The page summary (WikiPageSummary), spelled via WikiPage so it doesn't depend on that import.
  'wiki.patch': Omit<WikiPage, 'bodyMd' | 'backlinks' | 'backlinkCount'> & WikiSavedCitations;
  'wiki.delete': { deleted: true };
  'wiki.revisions': WikiRevision[];
  'wiki.restore': WikiPage;
  'wiki.lint': WikiLint;
  'media.list': AudioSegment[];
  'media.createUpload': UploadTarget & { segment: AudioSegment };
  'media.completeUpload': AudioSegment;
  'media.completeUploads': UploadsCompleted;
  'media.importFiles': FileImport;
  'media.playbackUrl': { url: string; expiresAt: string };
  'media.waveform': SegmentWaveform[];
  'media.importYoutube': Job;
  'media.importPlaylist': PlaylistImport;
  'media.retranscribe': Job[];
  'media.rewaveform': Job[];
  'media.delete': { deleted: true };
  'jobs.list': Job[];
  'jobs.dismiss': Job;
  'compilations.create': Compilation;
  'compilations.get': Compilation;
  'compilations.list': Compilation[];
  'compilations.delete': { ok: true };
  'compilations.retry': Compilation;
  'compilations.createUpload': CompilationUpload;
  'compilations.completeUpload': Compilation;
  search: SearchHit[];
  'moments.search': MomentSearch;
  'graph.entity': GraphEntity;
  'graph.export': GraphExportRows | GraphExportJsonLd;
  'changes.list': Change[];
  'changes.revert': Change;
  'changes.revertGroup': { groupId: string; reverted: number };
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

/** What ops that take `compact` return with `compact: true`, in place of their OpOutputs. */
export interface CompactOpOutputs {
  'events.list': CompactEventLine[];
  'events.createMany': CompactEventsAck;
  'events.updateMany': CompactEventsAck;
  'transcript.updateSegments': { updated: number; ids: string[] };
  'transcript.replace': TranscriptReplaceCompactResult;
  'topics.list': CompactTopicLine[];
  'topics.replace': CompactTopic[];
  'dashboards.save': CompactDashboard;
  'dashboards.updateWidgets': CompactDashboard;
  'wiki.upsert': CompactWikiPage;
  'wiki.patch': CompactWikiPage;
  'moments.search': CompactMomentSearch;
}

/**
 * What op N returns for input I: the compact shape when I has `compact: true`, the full one when
 * I has no `compact` or `compact: false`, and either when that is only known at run time
 * (`compact: boolean`, or an unknown input).
 */
export type OpResult<N extends OpName, I = OpInput<N>> = N extends keyof CompactOpOutputs
  ? unknown extends I
    ? OpOutputs[N] | CompactOpOutputs[N]
    : I extends { compact?: infer C }
      ? [C] extends [false | undefined]
        ? OpOutputs[N]
        : [C] extends [true]
          ? CompactOpOutputs[N]
          : OpOutputs[N] | CompactOpOutputs[N]
      : OpOutputs[N]
  : OpOutputs[N];

/** An op input that never asks for `compact` (the web app), so its result is the full shape. */
export type FullOpInput<N extends OpName> = OpInput<N> & { compact?: false };

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
