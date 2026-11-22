// Typed client for the ops registry: POST /api/rpc/<op> → { ok, data } | { ok:false, error }.

import type {
  Capabilities,
  OpInput,
  OpName,
  OpResult,
  RpcError as RpcErrorBody,
} from '@autologger/contract';

export type RpcErrorCode = RpcErrorBody['code'] | 'network';

export class RpcError extends Error {
  readonly code: RpcErrorCode;
  readonly status: number;
  readonly issues: { path: string; message: string }[];

  constructor(
    code: RpcErrorCode,
    message: string,
    status = 0,
    issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

/** Human-readable message for any thrown value (RpcError issues are appended). */
export function errorMessage(e: unknown): string {
  if (e instanceof RpcError) {
    if (e.issues.length)
      return `${e.message} ${e.issues.map((i) => `${i.path ? `${i.path}: ` : ''}${i.message}`).join('; ')}`;
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

async function parse<T>(res: Response): Promise<T> {
  type Body = { ok: boolean; data?: T; error?: RpcErrorBody } | null;
  let body: Body;
  try {
    body = (await res.json()) as Body;
  } catch {
    throw new RpcError(
      res.status >= 500 ? 'internal' : 'bad_request',
      `The server answered ${res.status} without a readable body.`,
      res.status,
    );
  }
  if (body?.ok) return body.data as T;
  const err = body?.error;
  throw new RpcError(
    err?.code ?? 'internal',
    err?.message ?? `Request failed (${res.status}).`,
    res.status,
    err?.issues ?? [],
  );
}

async function post<T>(url: string, input: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input ?? {}),
      signal,
    });
  } catch {
    throw new RpcError(
      'network',
      "Couldn't reach the server. Check your connection and try again.",
    );
  }
  return parse<T>(res);
}

/**
 * Calls op `name`; the result type follows the input (compact or full, see OpResult). Aborting
 * `signal` drops the request (the server stops a long-poll's wait when the client goes away).
 */
export function rpc<N extends OpName, I extends OpInput<N> = OpInput<N>>(
  name: N,
  input: I,
  signal?: AbortSignal,
): Promise<OpResult<N, I>> {
  return post<OpResult<N, I>>(`/api/rpc/${name}`, input, signal);
}

export async function getCapabilities(): Promise<Capabilities> {
  let res: Response;
  try {
    res = await fetch('/api/capabilities', { credentials: 'same-origin' });
  } catch {
    throw new RpcError(
      'network',
      "Couldn't reach the server. Check your connection and try again.",
    );
  }
  return parse<Capabilities>(res);
}

export const auth = {
  devLogin: (email: string, name?: string) =>
    post<{ userId: string }>('/auth/dev-login', { email, name }),
  logout: () => post<null>('/auth/logout', {}),
  googleStartUrl: (returnTo: string) => `/auth/google/start?return=${encodeURIComponent(returnTo)}`,
};

export interface OAuthRequestInfo {
  clientName: string;
  redirectHost: string;
  scope: string;
  expiresAt: string;
}

export const oauth = {
  async getRequest(id: string): Promise<OAuthRequestInfo> {
    let res: Response;
    try {
      res = await fetch(`/api/oauth/requests/${encodeURIComponent(id)}`, {
        credentials: 'same-origin',
      });
    } catch {
      throw new RpcError(
        'network',
        "Couldn't reach the server. Check your connection and try again.",
      );
    }
    return parse<OAuthRequestInfo>(res);
  },
  decide: (id: string, approve: boolean) =>
    post<{ redirectTo: string }>(`/api/oauth/requests/${encodeURIComponent(id)}/decision`, {
      approve,
    }),
};

export type ExportFormat =
  | 'events.csv'
  | 'events.jsonl'
  | 'transcript.txt'
  | 'transcript.srt'
  | 'topics.csv';
export const exportUrl = (sessionId: string, format: ExportFormat) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/export/${format}`;
