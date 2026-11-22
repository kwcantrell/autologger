import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase

function base32(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

/** Short, prefixed, URL-safe ids: `ses_7k2m9q4x1c0z`. */
export function newId(prefix: string, length = 14): string {
  return `${prefix}_${base32(randomBytes(length))}`;
}

/** A high-entropy secret with a recognisable prefix (`alp_…` tokens, `ald_…` device keys). */
export function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
