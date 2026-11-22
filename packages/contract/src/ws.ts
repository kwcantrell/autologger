// WebSocket messages.
//
// Session socket: GET /ws/session/:sessionId (cookie auth). Server → client only, apart from ping.
// Companion socket: GET /ws/companion with `Authorization: Bearer <device token>` (or ?token=).

import type { Session } from './entities.ts';
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
