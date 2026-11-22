// Tolerance for MCP clients whose tool list predates the server's: such a client doesn't know a
// new option's type and sends it as a string ("true", "250"). Coerce those strings by the tool's
// JSON input schema before the op validates them, and when validation still fails on a value the
// client sent, say that its tool list may be stale. MCP only; HTTP RPC stays strict.

import type { z } from 'zod';

type Schema = Record<string, unknown>;

const NUMERIC = /^\s*-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

/** The schema alternatives at one location (anyOf / oneOf flattened, $ref into $defs resolved). */
function alternatives(schema: unknown, root: Schema, depth = 0): Schema[] {
  if (!schema || typeof schema !== 'object' || depth > 8) return [];
  const s = schema as Schema;
  if (typeof s.$ref === 'string' && s.$ref.startsWith('#/$defs/')) {
    const defs = root.$defs as Record<string, unknown> | undefined;
    return alternatives(defs?.[s.$ref.slice('#/$defs/'.length)], root, depth + 1);
  }
  const branches = [s.anyOf, s.oneOf, s.allOf].flatMap((b) => (Array.isArray(b) ? b : []));
  if (branches.length) return branches.flatMap((b) => alternatives(b, root, depth + 1));
  return [s];
}

function typesOf(alts: Schema[]): Set<string> {
  const out = new Set<string>();
  for (const a of alts) {
    if (Array.isArray(a.type)) for (const t of a.type) out.add(String(t));
    else if (typeof a.type === 'string') out.add(a.type);
    else if ('const' in a) out.add(typeof a.const);
    else if (Array.isArray(a.enum)) for (const v of a.enum) out.add(typeof v);
    else out.add('any');
  }
  return out;
}

function coerceValue(value: unknown, alts: Schema[], root: Schema): unknown {
  if (!alts.length) return value;
  if (typeof value === 'string') {
    const types = typesOf(alts);
    // Anything that also takes a string keeps the string.
    if (types.has('string') || types.has('any')) return value;
    if (types.has('boolean') && (value === 'true' || value === 'false')) return value === 'true';
    if ((types.has('number') || types.has('integer')) && NUMERIC.test(value)) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items = alts.flatMap((a) => alternatives(a.items, root));
    return items.length ? value.map((v) => coerceValue(v, items, root)) : value;
  }
  if (value && typeof value === 'object') {
    const objects = alts.filter((a) => a.properties && typeof a.properties === 'object');
    if (!objects.length) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Every object branch that declares this key must agree it isn't a string.
      const props = objects.flatMap((o) =>
        alternatives((o.properties as Record<string, unknown>)[k], root),
      );
      out[k] = coerceValue(v, props, root);
    }
    return out;
  }
  return value;
}

/** Turn "true"/"false" and numeric strings into booleans/numbers where the schema wants those. */
export function coerceArguments(
  schema: Schema,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return coerceValue(args, alternatives(schema, schema), schema) as Record<string, unknown>;
}

export const STALE_TOOL_LIST_HINT =
  "Hint: this option may be newer than your client's tool list. If the tool's input schema you were given doesn't list it (or gives it another type), reconnect the AutoLogger MCP server (/mcp in Claude Code) to refresh the tools, then retry.";

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let v = input;
  for (const p of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<PropertyKey, unknown>)[p];
  }
  return v;
}

/** Whether a validation failure looks like a client using an outdated tool schema: a value sent
 * as a string where another type was expected, or a key the schema doesn't know. */
export function looksLikeStaleToolList(
  issues: readonly z.core.$ZodIssue[],
  input: unknown,
): boolean {
  return issues.some(
    (i) =>
      i.code === 'unrecognized_keys' ||
      (i.code === 'invalid_type' &&
        i.expected !== 'string' &&
        typeof valueAt(input, i.path) === 'string'),
  );
}
