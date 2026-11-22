import { describe, expect, it } from 'vitest';
import {
  pkceChallenge,
  redirectHost,
  redirectUriMatches,
  redirectUriProblem,
  refreshDecision,
  verifyPkce,
  withParams,
} from './oauth-core.ts';

describe('PKCE S256', () => {
  // RFC 7636 Appendix B test vector.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  it('computes the RFC 7636 challenge', () => {
    expect(pkceChallenge(verifier)).toBe(challenge);
  });
  it('verifies the matching verifier only', () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(`${verifier.slice(0, -1)}A`, challenge)).toBe(false);
    expect(verifyPkce(undefined, challenge)).toBe(false);
    expect(verifyPkce('short', pkceChallenge('short'))).toBe(false); // < 43 chars
  });
});

describe('redirect URIs', () => {
  it('accepts https, loopback http and private-use schemes', () => {
    expect(redirectUriProblem('https://claude.ai/api/mcp/auth_callback')).toBeNull();
    expect(redirectUriProblem('http://localhost:33418/callback')).toBeNull();
    expect(redirectUriProblem('http://127.0.0.1/cb')).toBeNull();
    expect(redirectUriProblem('claude://oauth/callback')).toBeNull();
  });
  it('rejects unsafe URIs', () => {
    expect(redirectUriProblem('http://evil.example/cb')).not.toBeNull();
    expect(redirectUriProblem('javascript:alert(1)')).not.toBeNull();
    expect(redirectUriProblem('https://a.example/cb#frag')).not.toBeNull();
    expect(redirectUriProblem('/relative')).not.toBeNull();
    expect(redirectUriProblem(42)).not.toBeNull();
  });
  it('matches exactly, with any port on loopback', () => {
    const reg = ['https://claude.ai/cb', 'http://localhost:3000/callback'];
    expect(redirectUriMatches(reg, 'https://claude.ai/cb')).toBe(true);
    expect(redirectUriMatches(reg, 'https://claude.ai/cb2')).toBe(false);
    expect(redirectUriMatches(reg, 'http://localhost:4567/callback')).toBe(true);
    expect(redirectUriMatches(reg, 'http://localhost:4567/other')).toBe(false);
    expect(redirectUriMatches(reg, 'http://127.0.0.1:3000/callback')).toBe(false);
  });
  it('builds redirects and display hosts', () => {
    expect(withParams('https://a.example/cb?x=1', { code: 'c', state: null })).toBe(
      'https://a.example/cb?x=1&code=c',
    );
    expect(redirectHost('https://claude.ai/cb')).toBe('claude.ai');
    expect(redirectHost('claude://oauth/cb')).toBe('claude://oauth');
  });
});

describe('refresh token rotation policy', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const live = { clientId: 'cli_a', revokedAt: null, expiresAt: new Date('2026-01-10T00:00:00Z') };
  it('rotates a live token for the right client', () => {
    expect(refreshDecision(live, 'cli_a', now)).toBe('rotate');
    expect(refreshDecision(live, undefined, now)).toBe('rotate');
  });
  it('rejects unknown, foreign-client and expired tokens', () => {
    expect(refreshDecision(null, 'cli_a', now)).toBe('reject');
    expect(refreshDecision(live, 'cli_b', now)).toBe('reject');
    expect(
      refreshDecision({ ...live, expiresAt: new Date('2025-12-31T00:00:00Z') }, 'cli_a', now),
    ).toBe('reject');
  });
  it('treats reuse of a rotated token as theft', () => {
    expect(
      refreshDecision({ ...live, revokedAt: new Date('2025-12-31T00:00:00Z') }, 'cli_a', now),
    ).toBe('reject_and_revoke_grant');
  });
});
