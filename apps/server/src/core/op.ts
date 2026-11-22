// The ops registry. Every capability is defined once here and dispatched from HTTP RPC,
// MCP tools and the Companion socket.

import {
  type ChangeEntity,
  type OpName,
  type OpOutputs,
  type OpParsed,
  opInputs,
  type Via,
} from '@autologger/contract';
import { db, schema, type Tx } from '../db/client.ts';
import { type BusMessage, publish, type Topic } from './bus.ts';
import { AppError, forbidden } from './errors.ts';
import { newId } from './ids.ts';

export type Surface = 'web' | 'mcp' | 'companion';

export interface ActorUser {
  id: string;
  email: string;
  name: string;
  isSuperadmin: boolean;
  status: 'pending' | 'active' | 'disabled';
}

export interface Actor {
  user: ActorUser;
  via: Via;
  /** MCP client / PAT name / device name, for attribution. */
  clientName: string | null;
  tokenId: string | null;
  /** Set for Companion devices: the only show the device may touch. */
  device: { id: string; showId: string; targetSessionId: string | null } | null;
}

export interface RecordChange {
  entity: ChangeEntity;
  entityId: string;
  kind: 'create' | 'update' | 'delete';
  summary: string;
  showId: string;
  sessionId?: string | null;
  before?: unknown;
  after?: unknown;
  revertOf?: string;
}

export interface Ctx {
  actor: Actor;
  db: Tx;
  op: OpName;
  /** Append to the change log in the current transaction. */
  record(change: RecordChange): Promise<string>;
  /** Queue a realtime message; delivered only after the transaction commits. */
  publish(topic: Topic, message: BusMessage): void;
}

export interface OpDef<N extends OpName, P = undefined> {
  name: N;
  /** Written for humans and agents alike; becomes the MCP tool description. */
  description: string;
  kind: 'read' | 'write';
  surfaces: readonly Surface[];
  /** When true, pending (unapproved) users may call it. */
  allowPending?: boolean;
  /**
   * Slow external work (e.g. running yt-dlp) done BEFORE the op's transaction opens, so no
   * connection or lock is held meanwhile. Authorize here too; `run` must re-authorize.
   * The result is passed to `run` as its third argument.
   */
  prepare?(actor: Actor, input: OpParsed<N>): Promise<P>;
  run(ctx: Ctx, input: OpParsed<N>, prepared: P): Promise<OpOutputs[N]>;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry
const registry = new Map<OpName, OpDef<any, any>>();

export function defineOp<N extends OpName, P = undefined>(def: OpDef<N, P>): OpDef<N, P> {
  if (registry.has(def.name)) throw new Error(`duplicate op ${def.name}`);
  registry.set(def.name, def);
  return def;
}

export function getOp(name: string): OpDef<OpName> | undefined {
  return registry.get(name as OpName);
}

export function listOps(surface?: Surface): OpDef<OpName>[] {
  return [...registry.values()].filter((o) => !surface || o.surfaces.includes(surface));
}

/** Strip generated / non-restorable columns before storing a row snapshot. */
export function snapshot<T extends Record<string, unknown>>(row: T | null | undefined): unknown {
  if (!row) return null;
  const { search: _s, ...rest } = row as T & { search?: unknown };
  return rest;
}

export async function executeOp<N extends OpName>(
  name: N,
  rawInput: unknown,
  actor: Actor,
  surface: Surface,
): Promise<OpOutputs[N]> {
  const op = registry.get(name) as OpDef<N, unknown> | undefined;
  if (!op?.surfaces.includes(surface)) throw new AppError('not_found', `Unknown op ${name}.`);
  if (actor.user.status === 'disabled') throw forbidden('This account is disabled.');
  if (actor.user.status === 'pending' && !op.allowPending) {
    throw forbidden('This account is waiting for approval by an administrator.');
  }
  const input = opInputs[name].parse(rawInput ?? {}) as OpParsed<N>;
  const prepared = op.prepare ? await op.prepare(actor, input) : undefined;

  const outbox: [Topic, BusMessage][] = [];
  const result = await db.transaction(async (tx) => {
    const ctx: Ctx = {
      actor,
      db: tx,
      op: name,
      publish: (topic, message) => outbox.push([topic, message]),
      async record(c) {
        const id = newId('chg');
        await tx.insert(schema.changes).values({
          id,
          actorId: actor.user.id,
          via: actor.via,
          clientName: actor.clientName,
          tokenId: actor.tokenId,
          op: name,
          entity: c.entity,
          entityId: c.entityId,
          kind: c.kind,
          summary: c.summary.slice(0, 500),
          sessionId: c.sessionId ?? null,
          showId: c.showId,
          before: c.before ?? null,
          after: c.after ?? null,
          revertOf: c.revertOf ?? null,
        });
        if (c.sessionId)
          outbox.push([`session:${c.sessionId}`, { type: 'invalidate', entity: 'change' }]);
        return id;
      },
    };
    return op.run(ctx, input, prepared);
  });
  for (const [topic, message] of outbox) publish(topic, message);
  return result;
}

/** Ops register themselves on import. */
export async function loadOps(): Promise<void> {
  await import('../ops/index.ts');
}
