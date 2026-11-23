import { formatIssues, type RpcError } from '@autologger/contract';
import { z } from 'zod';

export type ErrorCode = RpcError['code'];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly issues?: RpcError['issues'];
  constructor(code: ErrorCode, message: string, issues?: RpcError['issues']) {
    super(message);
    this.code = code;
    this.issues = issues;
  }
}

export const badRequest = (m: string) => new AppError('bad_request', m);
export const forbidden = (m = 'You do not have access to this.') => new AppError('forbidden', m);
export const notFound = (what: string) => new AppError('not_found', `${what} not found.`);
export const conflict = (m: string) => new AppError('conflict', m);
export const unavailable = (m: string) => new AppError('unavailable', m);

export const HTTP_STATUS: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 500 | 503> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  internal: 500,
};

export function toRpcError(err: unknown): RpcError {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, ...(err.issues ? { issues: err.issues } : {}) };
  }
  if (err instanceof z.ZodError) {
    return {
      code: 'bad_request',
      message: 'Invalid input.',
      issues: formatIssues(err.issues),
    };
  }
  // Unique-violation from Postgres → conflict.
  const pgCode =
    (err as { code?: string; cause?: { code?: string } })?.cause?.code ??
    (err as { code?: string })?.code;
  if (pgCode === '23505') return { code: 'conflict', message: 'That already exists.' };
  console.error(loggable(err));
  return { code: 'internal', message: 'Something went wrong on the server.' };
}

/**
 * An unexpected error as it may be logged. A failed Drizzle query's message and its `params`
 * carry every bound value (cookies, token hashes, user text), so for those only the SQL and the
 * driver's own error are kept.
 */
export function loggable(err: unknown): unknown {
  const e = err as {
    query?: unknown;
    params?: unknown;
    cause?: { message?: string; code?: string };
  };
  if (e && typeof e === 'object' && typeof e.query === 'string' && 'params' in e)
    return `Failed query: ${e.query}\n${e.cause?.code ?? ''} ${e.cause?.message ?? ''}`.trim();
  return err;
}
