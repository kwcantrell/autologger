// WebSocket messages.
//
// Session socket: GET /ws/session/:sessionId (cookie auth). Server → client only, apart from ping.
// Show socket: GET /ws/show/:showId (cookie auth): job and session-list changes of every session
// of the show (the rail's jobs indicator and session list) and change-log hints. Server → client
// only, apart from ping.
// Companion socket: GET /ws/companion with `Authorization: Bearer <device token>` (or ?token=).

import type { Job, Session } from './entities.ts';
import type { CompanionState, OpName, RpcError } from './ops.ts';

export type LiveEntity =
  | 'session'
  | 'event'
  | 'topic'
  | 'transcript_segment'
  | 'audio_segment'
  | 'dashboard'
  | 'job'
  | 'change';

export type SessionServerMessage =
  | { type: 'hello'; sessionId: string; serverTime: string }
  | {
      type: 'change';
      entity: LiveEntity;
      op: 'upsert' | 'delete';
      id: string;
      /** Full entity for upserts (shape per entity in entities.ts). */
      data?: unknown;
    }
  /** Many rows changed (e.g. transcript rewritten) — refetch the entity list. */
  | { type: 'invalidate'; entity: LiveEntity }
  | { type: 'transport'; session: Session }
  | { type: 'closed'; reason: 'access_revoked' | 'deleted' }
  | { type: 'pong' };

export type SessionClientMessage = { type: 'ping' };

export type ShowServerMessage =
  | { type: 'hello'; showId: string; serverTime: string }
  /** A job of one of the show's sessions, or a show-level (compile) job, changed (data: the Job, without estimates). */
  | { type: 'change'; entity: 'job'; op: 'upsert' | 'delete'; id: string; data?: Job }
  /**
   * `job`: jobs of the show changed, refetch them. `session`: the show's session list changed
   * (a session was created, deleted, renamed, archived, imported into or started rolling), or
   * its events changed (event counts; at most one such hint every few seconds per socket).
   * `compilation`: a compilation of the show was created, progressed, finished or was deleted.
   * `change`: the show's change log grew (a change in any of its sessions, or a show-level one;
   * at most one such hint every few seconds per socket).
   * `device`: a Companion device of the show was added, revoked, retargeted, connected or
   * disconnected (Settings → Companion devices: online state and last seen).
   */
  | { type: 'invalidate'; entity: 'job' | 'session' | 'compilation' | 'change' | 'device' }
  | { type: 'closed'; reason: 'access_revoked' | 'deleted' }
  | { type: 'pong' };

export type ShowClientMessage = { type: 'ping' };

export type CompanionClientMessage =
  | { type: 'op'; reqId: string; op: OpName; input: unknown }
  | { type: 'ping' };

export type CompanionServerMessage =
  | { type: 'state'; state: CompanionState; serverTime: string }
  | { type: 'result'; reqId: string; ok: true; data: unknown }
  | { type: 'result'; reqId: string; ok: false; error: RpcError }
  | { type: 'pong' };

/** Ops the companion socket accepts. */
export const COMPANION_OPS = [
  'companion.state',
  'transport.start',
  'transport.stop',
  'events.create',
] as const satisfies readonly OpName[];
