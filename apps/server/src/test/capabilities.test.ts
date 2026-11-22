import type { Capabilities } from '@autologger/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

// env is read once at import, so each case loads a fresh app with its own environment.
async function capabilities(vars: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  const { createApp } = await import('../http/app.ts');
  const res = await createApp().request('/api/capabilities');
  return ((await res.json()) as { data: Capabilities }).data;
}

afterEach(() => vi.unstubAllEnvs());

describe('GET /api/capabilities', () => {
  it('reports the landing page on by default', async () => {
    expect((await capabilities({ LANDING_PAGE: '' })).landingPage).toBe(true);
  });

  it('reports it off with LANDING_PAGE=0', async () => {
    expect((await capabilities({ LANDING_PAGE: '0' })).landingPage).toBe(false);
  });

  it('reports no docs URL by default', async () => {
    expect((await capabilities({ DOCS_URL: '' })).docsUrl).toBeNull();
  });

  it('reports DOCS_URL without its trailing slash, and ignores non-http values', async () => {
    const url = 'https://docs.example.com/autologger/';
    expect((await capabilities({ DOCS_URL: url })).docsUrl).toBe(url.slice(0, -1));
    expect((await capabilities({ DOCS_URL: 'javascript:alert(1)' })).docsUrl).toBeNull();
  });
});
