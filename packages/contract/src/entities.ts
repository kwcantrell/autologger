// API entity shapes. These are what ops return and what the web renders.
// Times are ISO strings; session-relative times are seconds (`*Sec`) or frames (`*Frames`).

import type { DashboardSpec } from './dashboard.ts';
import type { TranscriptRule, TranscriptRuleCount } from './transcriptRules.ts';

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
  createdBy: UserRef | null;
  access: ShowAccess;
}

/** sessions.get: a session plus its unfinished transcription work. */
export interface SessionDetail extends Session {
  transcriptJob: TranscriptJob | null;
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
  status: SegmentStatus;
  error: string | null;
  createdAt: string;
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
  context?: true;
}

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

export type WikiKind = 'person' | 'topic' | 'bit' | 'session';

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
}

/** A page of wiki.list. `nextOffset` is null on the last page. */
export interface WikiList {
  pages: WikiListItem[];
  total: number;
  nextOffset: number | null;
}

export interface WikiLint {
  /** Pages whose [[links]] name no page title or alias in the show. */
  unresolved: { pageId: string; title: string; kind: WikiKind; targets: string[] }[];
  /** Person, topic and bit pages no other page links to (session recaps are left out). */
  orphans: { pageId: string; title: string; kind: WikiKind }[];
  counts: { pages: number; links: number; unresolvedLinks: number; orphans: number };
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
  | 'category';

export interface Change {
  id: string;
  at: string;
  actor: UserRef | null;
  via: Via;
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
  rank: number;
}

export interface Capabilities {
  googleAuth: boolean;
  devLogin: boolean;
  storage: boolean;
  transcription: boolean;
  youtube: boolean;
  publicUrl: string;
}
