// Bearer-token resolution for agents (PATs and OAuth access tokens).
// STUB — implemented by the MCP/OAuth work package.

import type { Actor } from '../core/op.ts';

/** Resolve `Authorization: Bearer <token>` to an MCP actor, or null when invalid/revoked/expired. */
export async function actorFromBearer(_token: string): Promise<Actor | null> {
  return null;
}
