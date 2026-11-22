// Test harness: real Postgres, real ops, actors constructed directly.

import type { OpInput, OpName, OpResult } from '@autologger/contract';
import { sql } from 'drizzle-orm';
import { newId } from '../core/ids.ts';
import { type Actor, executeOp, loadOps, type Surface } from '../core/op.ts';
import { db, schema } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';

let ready: Promise<void> | null = null;

export function setupDb(): Promise<void> {
  ready ??= (async () => {
    await runMigrations();
    await loadOps();
  })();
  return ready;
}

/** Wipe all data between tests (keeps schema). */
export async function resetDb(): Promise<void> {
  await db.execute(sql`truncate users, teams, oauth_clients, jobs restart identity cascade`);
}

export async function makeUser(
  email: string,
  opts: { status?: 'pending' | 'active' | 'disabled'; superadmin?: boolean } = {},
): Promise<Actor> {
  const id = newId('usr');
  await db.insert(schema.users).values({
    id,
    email,
    name: email.split('@')[0]!,
    status: opts.status ?? 'active',
    isSuperadmin: opts.superadmin ?? false,
  });
  return {
    user: {
      id,
      email,
      name: email.split('@')[0]!,
      isSuperadmin: opts.superadmin ?? false,
      status: opts.status ?? 'active',
    },
    via: 'web',
    clientName: null,
    tokenId: null,
    device: null,
  };
}

export function asAgent(actor: Actor, clientName = 'Test Agent'): Actor {
  return { ...actor, via: 'mcp', clientName };
}

export function call<N extends OpName, I extends OpInput<N>>(
  actor: Actor,
  name: N,
  input: I,
  surface?: Surface,
): Promise<OpResult<N, I>> {
  return executeOp(
    name,
    input,
    actor,
    surface ?? (actor.via === 'mcp' ? 'mcp' : actor.via === 'companion' ? 'companion' : 'web'),
  );
}

/** Expect an op to fail with a given error code. */
export async function failsWith(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const actual =
      (e as { code?: string }).code ??
      (e instanceof Error && e.name === 'ZodError' ? 'bad_request' : 'unknown');
    if (actual !== code)
      throw new Error(`expected ${code}, got ${actual}: ${(e as Error).message}`);
    return;
  }
  throw new Error(`expected ${code}, but the op succeeded`);
}

/** Owner + team + show + session fixture. */
export async function studio() {
  const owner = await makeUser(`owner-${newId('x')}@example.com`);
  const team = await call(owner, 'teams.create', { name: 'Studio' });
  const show = await call(owner, 'shows.create', { teamId: team.id, name: 'Late Night Talk' });
  const session = await call(owner, 'sessions.create', {
    showId: show.id,
    startTimecode: '01:00:00:00',
  });
  return { owner, team, show, session };
}
