// API entity shapes. These are what ops return and what the web renders.
// Times are ISO strings; session-relative times are seconds (`*Sec`) or frames (`*Frames`).

import type { DashboardSpec } from './dashboard.ts';

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
  archivedAt: string | null;
  createdAt: string;
  createdBy: UserRef | null;
  access: ShowAccess;
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

export interface WikiPage extends WikiPageSummary {
  bodyMd: string;
  /** Pages that link to this one via [[Title]]. */
  backlinks: { id: string; title: string; kind: WikiKind }[];
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
  error: string | null;
  progress: string | null;
  createdAt: string;
  updatedAt: string;
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
