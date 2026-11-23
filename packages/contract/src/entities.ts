// API entity shapes. These are what ops return and what the web renders.
// Times are ISO strings; session-relative times are seconds (`*Sec`) or frames (`*Frames`).

import type { DashboardSpec } from './dashboard.ts';
import type { TranscriptRule, TranscriptRuleCount } from './transcriptRules.ts';
import type { WikiCitation } from './wikiLinks.ts';

export type TeamRole = 'owner' | 'admin' | 'member';
export type UserStatus = 'pending' | 'active' | 'disabled';
export type Via = 'web' | 'mcp' | 'companion' | 'worker' | 'system';
export type ShowAccess = 'manage' | 'write' | 'read';

export interface UserRef {
  id: string;
  name: string;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  pictureUrl: string | null;
  status: UserStatus;
  isSuperadmin: boolean;
  teams: Team[];
}

export interface Team {
  id: string;
  name: string;
  role: TeamRole;
  createdAt: string;
}

export interface TeamMember {
  userId: string;
  email: string;
  name: string;
  pictureUrl: string | null;
  role: TeamRole;
  joinedAt: string;
  /** Show ids the member is granted (owner/admin implicitly see all). */
  grants: { showId: string; canWrite: boolean }[];
}

export interface TeamInvite {
  email: string;
  role: TeamRole;
  invitedAt: string;
  invitedBy: UserRef | null;
}

export interface TeamDetail extends Team {
  members: TeamMember[];
  invites: TeamInvite[];
}

export type CategoryKind = 'button' | 'dropdown' | 'text' | 'toggle';

export interface Category {
  id: string;
  showId: string;
  /** 0-based; positions 0–8 map to hotkeys 1–9. */
  position: number;
  name: string;
  color: string;
  kind: CategoryKind;
  options: string[];
  onLabel: string;
  offLabel: string;
}

export interface Show {
  id: string;
  teamId: string;
  teamName: string;
  name: string;
  code: string;
  nextEpisode: number;
  defaultFrameRate: number;
  titleSuffix: 'date' | 'episode' | 'none';
  /** Transcription: Deepgram smart formatting (numerals, dates, currency…). Default true. */
  smartFormat: boolean;
  /** Transcription: key terms the transcriber should favour (Deepgram keyterm prompting). */
  keyTerms: string[];
  /** Transcription: find/replace rules applied, in order, to every new transcription. */
  transcriptRules: TranscriptRule[];
  createdAt: string;
  access: ShowAccess;
  sessionCount: number;
  lastSessionAt: string | null;
}

/**
 * A team's YouTube sign-in for the server's yt-dlp (media.youtubeAccess), used by all its shows.
 * Never includes the cookies themselves.
 */
export interface YoutubeAccess {
  teamId: string;
  teamName: string;
  /** Cookies are stored for this team. */
  configured: boolean;
  /** The server also has instance-wide cookies (YTDLP_COOKIES_FILE), used when the team has none. */
  serverCookies: boolean;
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
  /** Earliest expiry of the stored sign-in cookies, when they have one. */
  expiresAt: string | null;
  /** Last time YouTube accepted / refused the cookies (refused = bot check or sign-in error). */
  lastOkAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
}

export type MediaSource = 'recorded' | 'file' | 'youtube';

export interface Session {
  id: string;
  showId: string;
  showName: string;
  title: string;
  episode: string;
  episodeDate: string | null;
  notes: string;
  frameRate: number;
  startOffsetFrames: number;
  isRolling: boolean;
  rollStartedAt: string | null;
  elapsedFrames: number;
  take: number;
  eventCount: number;
  audioSeconds: number;
  transcriptStatus: 'none' | 'pending' | 'partial' | 'done' | 'failed';
  sourceKind: MediaSource | null;
  sourceUrl: string | null;
  /** Transcription: key terms for this session only, sent before the show's key terms. */
  keyTerms: string[];
  archivedAt: string | null;
  createdAt: string;
  /** When the session row (title, clock, transport, source…) last changed; not bumped by its
   *  events, recordings or transcript. Clients use it to drop a result older than a live push. */
  updatedAt: string;
  createdBy: UserRef | null;
  access: ShowAccess;
}

/** sessions.get: a session plus its unfinished transcription work. */
/**
 * An event button as sessions.get lists it for agents: `options` only on dropdowns, the labels
 * only on toggles (the values an event's `value` takes).
 */
export interface SessionButton {
  id: string;
  name: string;
  kind: CategoryKind;
  options?: string[];
  onLabel?: string;
  offLabel?: string;
}

export interface SessionDetail extends Session {
  transcriptJob: TranscriptJob | null;
  /** MCP callers only: the show's event buttons in hotkey order (the web uses categories.list). */
  categories?: SessionButton[];
}

export type EventSource = 'operator' | 'companion' | 'agent' | 'import';

export interface SessionEvent {
  id: string;
  sessionId: string;
  categoryId: string | null;
  category: string;
  color: string;
  message: string;
  /** Dropdown option / toggle state ("ON"/"OFF") when the category has one. */
  value: string | null;
  timecodeFrames: number | null;
  /** Seconds from the session start (lines up with transcript times); null without a timecode. */
  atSec: number | null;
  wallTime: string;
  take: number;
  source: EventSource;
  createdBy: UserRef | null;
  createdAt: string;
  updatedAt: string;
}

export type SegmentStatus = 'uploading' | 'ready' | 'transcribing' | 'transcribed' | 'failed';

export interface AudioSegment {
  id: string;
  sessionId: string;
  ordinal: number;
  /** Session time where this segment starts. */
  startSec: number;
  durationSec: number | null;
  mimeType: string;
  origin: MediaSource;
  fileName: string | null;
  /** YouTube origin: the video URL the audio came from (null for older imports). */
  sourceUrl: string | null;
  /**
   * Uploaded by the local import helper from a video the server cannot download (private):
   * compilations of it must be built locally (compilations.create buildLocally).
   */
  sourcePrivate: boolean;
  status: SegmentStatus;
  error: string | null;
  /** Waveform peaks have been computed (read them with media.waveform). */
  hasWaveform: boolean;
  createdAt: string;
}

/** One audio segment's waveform peaks (media.waveform). */
export interface SegmentWaveform {
  segmentId: string;
  /** Session second where the segment (peak 0) starts. */
  startSec: number;
  durationSec: number | null;
  /**
   * Presigned GET (JSON {version: 1, peaksPerSec, durationSec, peaks}; peaks is base64 of one
   * byte per 1/peaksPerSec s: max |sample| scaled to 0–255).
   */
  url: string;
  expiresAt: string;
}

export interface TranscriptWord {
  w: string;
  s: number;
  e: number;
  /** Diarized speaker index from transcription (0-based: "Speaker 1" is 0), when known. */
  sp?: number;
}

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  audioSegmentId: string | null;
  startSec: number;
  endSec: number;
  speaker: string;
  text: string;
  words: TranscriptWord[];
  edited: boolean;
}

/** A transcript segment without word timings — the compact shape agents search and edit. */
export interface TranscriptLine {
  id: string;
  startSec: number;
  endSec: number;
  speaker: string;
  text: string;
  edited: boolean;
}

/** One segment a transcript.replace call changes (or would change, in a dry run). */
export interface TranscriptReplaceChange {
  id: string;
  startSec: number;
  endSec: number;
  speaker: string;
  before: string;
  after: string;
}

export interface TranscriptReplaceResult {
  dryRun: boolean;
  /** Segments changed (or that would change). */
  changed: number;
  /** Matches per rule, in rule order. */
  rules: TranscriptRuleCount[];
  /** The changed segments in time order, at most TRANSCRIPT_REPLACE_LIST_LIMIT of them. */
  segments: TranscriptReplaceChange[];
  /** True when more segments changed than `segments` lists. */
  truncated: boolean;
}

/** transcript.replace with `compact: true`: counts instead of every before/after text. */
export interface TranscriptReplaceCompactResult {
  dryRun: boolean;
  /** Segments changed (or that would change). */
  changed: number;
  /** Matches over all rules. */
  replacements: number;
  /** The rules that matched, in rule order. */
  rules: { find: string; count: number }[];
  /** dryRun only: the first few changes, each cut to the changed words plus a little context. */
  samples?: { id: string; startSec: number; before: string; after: string }[];
}

/**
 * A transcript.find result line. Matched lines carry the matched substrings and the indexes of the
 * patterns that hit; neighbouring lines requested with `context` carry `context: true` instead.
 */
export interface TranscriptFindLine extends TranscriptLine {
  matches?: string[];
  patternIndexes?: number[];
  /** With `suspect: true`: why this turn may hold two speakers (see SUSPECT_TURN_REASONS). */
  reasons?: SuspectTurnReason[];
  context?: true;
}

/**
 * transcript.find `suspect: true` heuristics, in `counts` order: `question` — a question followed
 * by at least SUSPECT_QUESTION_WORDS more words in the same turn (a question and its answer);
 * `long` — a turn longer than SUSPECT_LONG_SEC seconds.
 */
export const SUSPECT_TURN_REASONS = ['question', 'long'] as const;
export type SuspectTurnReason = (typeof SUSPECT_TURN_REASONS)[number];
export const SUSPECT_QUESTION_WORDS = 20;
export const SUSPECT_LONG_SEC = 60;

/** A transcript.find line with `idsOnly: true`: enough to target an edit, no text. */
export interface TranscriptFindId {
  id: string;
  startSec: number;
  speaker: string;
}

export interface Topic {
  id: string;
  sessionId: string;
  startSec: number;
  durationSec: number;
  level: number;
  title: string;
  summary: string;
  createdBy: UserRef | null;
  via: Via;
  createdAt: string;
}

export interface Dashboard {
  id: string;
  sessionId: string;
  title: string;
  spec: DashboardSpec;
  revision: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
  via: Via;
  createdAt: string;
  updatedAt: string;
}

export type WikiKind = 'person' | 'topic' | 'bit' | 'session' | 'question';

export interface WikiPageSummary {
  id: string;
  showId: string;
  kind: WikiKind;
  title: string;
  aliases: string[];
  sessionId: string | null;
  revision: number;
  updatedAt: string;
  updatedBy: UserRef | null;
}

/** A wiki.list row; `summary` / `bodyMd` only with `include: 'summary'` / `'body'`. */
export interface WikiListItem extends WikiPageSummary {
  /** First paragraph of the body (headings skipped), at most 400 characters. */
  summary?: string;
  bodyMd?: string;
  /** With `citesSession`: this page's citations of that session, in body order. */
  citations?: Omit<WikiCitation, 'sessionId'>[];
  /** With `citesSession` and `countOnly`: how many times this page cites that session. */
  citationCount?: number;
}

/** A page of wiki.list. `nextOffset` is null on the last page. */
export interface WikiList {
  pages: WikiListItem[];
  total: number;
  nextOffset: number | null;
  /** With `citesSession`: citations of that session across all matching pages (not just this page). */
  citationTotal?: number;
}

export interface WikiLint {
  /** Pages whose [[links]] name no page title or alias in the show. */
  unresolved: { pageId: string; title: string; kind: WikiKind; targets: string[] }[];
  /** Person, topic and bit pages no other page links to (session recaps are left out). */
  orphans: { pageId: string; title: string; kind: WikiKind }[];
  /** Pages with citations ([label](/sessions/<id>?t=&to=)) that point at no usable range. */
  badCitations: {
    pageId: string;
    title: string;
    kind: WikiKind;
    citations: (WikiCitation & { problem: WikiCitationProblem })[];
  }[];
  counts: {
    pages: number;
    links: number;
    unresolvedLinks: number;
    orphans: number;
    citations: number;
    badCitations: number;
  };
}

/**
 * Why wiki.lint flags a citation: `unknown_session` (no session with that id in this show),
 * `bad_range` (`to` is not after `t`), `past_end` (the range ends after the session's audio),
 * `label_mismatch` (the label starts with an HH:MM:SS timecode that is not the cited `t` / `to`).
 */
export type WikiCitationProblem = 'unknown_session' | 'bad_range' | 'past_end' | 'label_mismatch';

/** What wiki.upsert / wiki.patch report about the saved page's citations (wiki.lint's checks). */
export interface WikiSavedCitations {
  /** Citations in the saved body, repeats counted. */
  citationCount: number;
  /** The saved page's citations that wiki.lint flags, in body order. */
  badCitations: (WikiCitation & { problem: WikiCitationProblem })[];
  /**
   * Citations whose `to` this save clamped to the session's audio end (it overshot by at most
   * 5 s), in body order: `endSec` is the stored end, `sentEndSec` the end as sent. The stored body
   * then differs from what was sent there (e.g. `to=6184.8` instead of `to=6185`).
   */
  clampedCitations: (Required<WikiCitation> & { sentEndSec: number })[];
}

export interface WikiPage extends WikiPageSummary {
  bodyMd: string;
  /** Pages that link to this one via [[Title]] or an alias, by title; the first 50. */
  backlinks: { id: string; title: string; kind: WikiKind }[];
  /** How many pages link to this one (backlinks lists at most 50). */
  backlinkCount: number;
}

export interface WikiRevision {
  revision: number;
  title: string;
  bodyMd: string;
  author: UserRef | null;
  via: Via;
  at: string;
}

export type ChangeEntity =
  | 'event'
  | 'topic'
  | 'transcript_segment'
  | 'dashboard'
  | 'wiki_page'
  | 'category'
  /** A session clock change (frameRate, startOffsetFrames) from sessions.update. */
  | 'session'
  /** A recording's transcription status (status, error), e.g. set by transcript.import. */
  | 'audio_segment';

export interface Change {
  id: string;
  at: string;
  actor: UserRef | null;
  via: Via;
  /** The MCP client (via mcp) or the Companion device name (via companion) that made the change. */
  clientName: string | null;
  op: string;
  entity: ChangeEntity;
  entityId: string;
  kind: 'create' | 'update' | 'delete';
  summary: string;
  sessionId: string | null;
  showId: string;
  revertedAt: string | null;
  revertOf: string | null;
  /** Shared by every change one op call wrote; null on changes logged before groups existed. */
  groupId: string | null;
  /** changes.list with grouped: true — how many changes this row stands for (only when > 1). */
  groupSize?: number;
  /** With groupSize: how many of them are already undone. */
  groupUndone?: number;
  /**
   * With groupSize: how many changes the whole group has, in every session (the session filter
   * only counts its own). changes.revertGroup undoes all of them.
   */
  groupTotal?: number;
  /**
   * Session content (event, topic, transcript segment): where in the session the change was, in
   * seconds from the session start — from its `after` snapshot, or `before` for a delete. Absent
   * for other changes and for untimed events.
   */
  atSec?: number;
}

export interface ApiToken {
  id: string;
  kind: 'pat' | 'oauth';
  name: string;
  clientName: string | null;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface CompanionDevice {
  id: string;
  name: string;
  showId: string;
  targetSessionId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
}

export interface Job {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  sessionId: string | null;
  /** Set when listing a whole show (jobs.list with showId). */
  sessionTitle?: string;
  /** Jobs about one audio segment (transcribe, waveform): that segment's id (media.list). */
  segmentId?: string;
  /** youtube_import jobs: the video URL being imported (pass it to media.importYoutube to retry). */
  sourceUrl?: string;
  /** compile jobs (show-level, sessionId null): the compilation they build. */
  compilationId?: string;
  /** compile jobs listed by showId: the compilation's title; absent once it was deleted. */
  compilationTitle?: string;
  /** Queued jobs only (jobs.list): jobs ahead of this one in the worker queue, 0 = next. */
  queuePosition?: number;
  /**
   * Queued and running jobs (jobs.list): rough estimate of seconds until the job finishes, from
   * recent finished jobs of the same kind. Absent when there is no history to estimate from.
   */
  etaSec?: number;
  error: string | null;
  progress: string | null;
  /** When the current (or last) attempt started; null while queued. */
  startedAt: string | null;
  /** Failed jobs: when the failure was acknowledged with jobs.dismiss; null otherwise. */
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CompilationStatus = 'queued' | 'running' | 'ready' | 'failed';

export interface CompilationClip {
  sessionId: string;
  /** The session's current title (its title at creation if the session was deleted since). */
  sessionTitle: string;
  /** Seconds from the session start, as transcript_text's @seconds. */
  startSec: number;
  endSec: number;
  label?: string;
  /** The "Compilation" event logged for this clip in its session (absent with logEvents: false). */
  eventId?: string;
}

/** A video built by the worker from ranges of YouTube-sourced sessions (compilations.*). */
export interface Compilation {
  id: string;
  showId: string;
  title: string;
  status: CompilationStatus;
  /** While queued or running, e.g. "clip 3/12". */
  progress?: string;
  /** When failed: why. */
  error?: string;
  /**
   * Built by the local import helper (`autologger-import compile <id>`) instead of the server:
   * it stays queued until the helper uploads the MP4 (compilations.completeUpload).
   */
  buildLocally: boolean;
  clips: CompilationClip[];
  /** Seconds: the sum of the clip lengths, then the built video's measured length once ready. */
  durationSec: number;
  sizeBytes?: number;
  /** Queued only: jobs the worker starts before this compilation's build, 0 = next (as jobs.list). */
  queuePosition?: number;
  /**
   * Queued and running: rough seconds until the video is ready, from recent builds' time per clip
   * second (as jobs.list etaSec). Absent when there is no history to estimate from.
   */
  etaSec?: number;
  /** Ready only: presigned GET of the MP4, valid about 1 hour (see urlExpiresAt). */
  url?: string;
  urlExpiresAt?: string;
  createdBy: UserRef | null;
  createdAt: string;
  updatedAt: string;
}

/** sessions.get: the queued or running job that will produce the session's transcript. */
export interface TranscriptJob {
  id: string;
  kind: string;
  status: 'queued' | 'running';
  queuePosition?: number;
  etaSec?: number;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  isSuperadmin: boolean;
  createdAt: string;
  teams: { id: string; name: string; role: TeamRole }[];
}

export interface SearchHit {
  kind: 'event' | 'transcript' | 'topic' | 'wiki' | 'session';
  id: string;
  sessionId: string | null;
  showId: string;
  sessionTitle: string | null;
  /**
   * The session's episode date (`YYYY-MM-DD`), or its creation time (ISO instant) when it has no
   * episode date — tells apart sessions with the same title. Null for wiki hits.
   */
  sessionDate: string | null;
  showName: string;
  title: string;
  snippet: string;
  /** Session seconds for event/transcript/topic hits. */
  atSec: number | null;
  /** Where a transcript line or topic ends (session seconds); null for events, wiki pages, sessions and zero-length topics. */
  endSec: number | null;
  rank: number;
}

export interface Capabilities {
  googleAuth: boolean;
  devLogin: boolean;
  storage: boolean;
  transcription: boolean;
  youtube: boolean;
  publicUrl: string;
  /** Signed-out visitors at `/` see the public landing page; false sends them to /login (LANDING_PAGE=0). */
  landingPage: boolean;
  /**
   * Base URL of an external copy of the docs (DOCS_URL); the web app's doc links resolve as
   * `<docsUrl>/<section>/<slug>` (e.g. `<docsUrl>/developers/mcp-server`). Null keeps the
   * built-in pages at `/docs/<section>/<slug>`.
   */
  docsUrl: string | null;
}
