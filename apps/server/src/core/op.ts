// The ops registry. Every capability is defined once here and dispatched from HTTP RPC,
// MCP tools and the Companion socket.

import {
  type ChangeEntity,
  type OpName,
  type OpParsed,
  type OpResult,
  opInputs,
  type Via,
} from '@autologger/contract';
import { sql } from 'drizzle-orm';
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
  /** Shared by every change this op call records; `changes.revertGroup` undoes them together. */
  groupId: string;
  /** Append to the change log in the current transaction. */
  record(change: RecordChange): Promise<string>;
  /** `record` for many changes in a few INSERTs (bulk writes); returns their ids in order. */
  recordMany(changes: RecordChange[]): Promise<string[]>;
  /** Queue a realtime message; delivered only after the transaction commits. */
  publish(topic: Topic, message: BusMessage): void;
  /**
   * Queue slow external cleanup (e.g. deleting S3 objects) to run after the transaction commits,
   * so no connection or lock is held meanwhile. Skipped when the op fails; best effort: errors
   * are logged, never thrown to the caller.
   */
  afterCommit(task: () => Promise<void>): void;
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
  run(ctx: Ctx, input: OpParsed<N>, prepared: P): Promise<OpResult<N, OpParsed<N>>>;
  /**
   * Optional long-poll. Called before the transaction, so it can start listening and miss
   * nothing. After commit, `wait(result)` returns a promise that resolves when the answer may
   * have changed, on timeout or on `signal` abort, and the op runs again in a fresh transaction
   * (unless aborted); null answers at once. Waiting must not touch the database, so a waiting
   * request holds no transaction or pooled connection. `cancel` is always called at the end.
   */
  watch?(input: OpParsed<N>, signal?: AbortSignal): OpWatch<OpResult<N, OpParsed<N>>> | null;
}

export interface OpWatch<R> {
  wait(result: R): Promise<void> | null;
  cancel(): void;
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

/** Runs op `name`; the result type follows the input (see OpResult; unknown input: either). */
export async function executeOp<N extends OpName, I = unknown>(
  name: N,
  rawInput: I,
  actor: Actor,
  surface: Surface,
  signal?: AbortSignal,
): Promise<OpResult<N, I>> {
  const op = registry.get(name) as OpDef<N, unknown> | undefined;
  if (!op?.surfaces.includes(surface)) throw new AppError('not_found', `Unknown op ${name}.`);
  if (actor.user.status === 'disabled') throw forbidden('This account is disabled.');
  if (actor.user.status === 'pending' && !op.allowPending) {
    throw forbidden('This account is waiting for approval by an administrator.');
  }
  const input = opInputs[name].parse(rawInput ?? {}) as OpParsed<N>;
  const prepared = op.prepare ? await op.prepare(actor, input) : undefined;

  const watch = op.watch?.(input, signal);
  try {
    const result = await runInTransaction(op, input, actor, prepared);
    // The op returned the shape its parsed input asked for, which is the one `I` names.
    const waiting = watch?.wait(result);
    if (!waiting) return result as OpResult<N, I>;
    await waiting;
    if (signal?.aborted) return result as OpResult<N, I>;
    return (await runInTransaction(op, input, actor, prepared)) as OpResult<N, I>;
  } finally {
    watch?.cancel();
  }
}

async function runInTransaction<N extends OpName>(
  op: OpDef<N, unknown>,
  input: OpParsed<N>,
  actor: Actor,
  prepared: unknown,
): Promise<OpResult<N, OpParsed<N>>> {
  const name = op.name;
  const outbox: [Topic, BusMessage][] = [];
  const tasks: (() => Promise<void>)[] = [];
  const groupId = newId('grp');
  const result = await db.transaction(async (tx) => {
    const ctx: Ctx = {
      actor,
      db: tx,
      op: name,
      groupId,
      publish: (topic, message) => outbox.push([topic, message]),
      afterCommit: (task) => tasks.push(task),
      async record(c) {
        const [id] = await ctx.recordMany([c]);
        return id!;
      },
      async recordMany(list) {
        const rows = list.map((c) => ({
          id: newId('chg'),
          // Wall clock, not now(): changes in one transaction keep their order (undo relies on it).
          at: sql`clock_timestamp()`,
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
          groupId,
        }));
        // Chunked to stay under the Postgres bind-parameter limit.
        for (let i = 0; i < rows.length; i += 1000)
          await tx.insert(schema.changes).values(rows.slice(i, i + 1000));
        for (const c of list)
          if (c.sessionId)
            outbox.push([`session:${c.sessionId}`, { type: 'invalidate', entity: 'change' }]);
        return rows.map((r) => r.id);
      },
    };
    return op.run(ctx, input, prepared);
  });
  // Bulk writes record one change per row; send each identical message (e.g. invalidate) once.
  const sent = new Set<string>();
  for (const [topic, message] of outbox) {
    const key = `${topic} ${JSON.stringify(message)}`;
    if (sent.has(key)) continue;
    sent.add(key);
    publish(topic, message);
  }
  for (const task of tasks) {
    try {
      await task();
    } catch (e) {
      console.warn(`${name}: after-commit task failed: ${(e as Error).message}`);
    }
  }
  return result;
}

/** Ops register themselves on import. */
export async function loadOps(): Promise<void> {
  await import('../ops/index.ts');
}
