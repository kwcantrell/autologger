// biome-ignore-all lint/suspicious/noExplicitAny: smoke script inspects arbitrary JSON responses
// End-to-end smoke test for agent access against a running dev server (DEV_LOGIN=1):
// PAT → MCP initialize / tools/list / tools/call, then the full OAuth flow
// (register → authorize → consent → token + PKCE → MCP → refresh rotation → reuse detection → revoke).
//
//   node scripts/mcp-smoke.ts [baseUrl]      (default http://localhost:18081)

import { createHash, randomBytes } from 'node:crypto';

const BASE = (process.argv[2] ?? 'http://localhost:18081').replace(/\/$/, '');
let cookie = '';
let failures = 0;

function check(label: string, cond: unknown, extra?: unknown): void {
  if (cond) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}`, extra ?? '');
  }
}

async function rpc<T = any>(op: string, input: unknown = {}, auth?: string): Promise<T> {
  const res = await fetch(`${BASE}/api/rpc/${op}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}` } : { cookie }),
    },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as { ok: boolean; data: T; error?: unknown };
  if (!body.ok) throw new Error(`${op}: ${JSON.stringify(body.error)}`);
  return body.data;
}

let rpcId = 0;
async function mcp(token: string | null, method: string, params: unknown = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json, text };
}

const initParams = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '1' },
};

// ── sign in and set up data ──
{
  const res = await fetch(`${BASE}/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com' }),
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  check('dev login', res.ok && cookie.startsWith('al_session='));
}
const teams = await rpc<any[]>('teams.list');
const team = teams[0] ?? (await rpc('teams.create', { name: 'Smoke Team' }));
const show = await rpc('shows.create', { teamId: team.id, name: `MCP Smoke ${Date.now()}` });
const session = await rpc('sessions.create', { showId: show.id });

// ── PAT ──
const pat = await rpc<{ token: string; apiToken: { id: string } }>('tokens.createPat', {
  name: 'smoke PAT',
});
check('PAT created with alp_ prefix', pat.token.startsWith('alp_'));
{
  const r = await mcp(null, 'initialize', initParams);
  check(
    'unauthenticated /mcp → 401 + WWW-Authenticate',
    r.status === 401 && /resource_metadata=/.test(r.headers.get('www-authenticate') ?? ''),
    r.headers.get('www-authenticate'),
  );
}
{
  const r = await mcp(pat.token, 'initialize', initParams);
  check(
    'initialize',
    r.json?.result?.serverInfo?.name === 'autologger' && r.json.result.instructions,
    r.text,
  );
  const tools = await mcp(pat.token, 'tools/list');
  const list = tools.json?.result?.tools ?? [];
  console.log(`     ${list.length} tools`);
  check(
    'tools/list has sessions_list / events_create / topics_replace',
    ['sessions_list', 'events_create', 'topics_replace'].every((n) =>
      list.some((t: any) => t.name === n),
    ),
  );
  check('no web-only tools exposed', !list.some((t: any) => t.name.startsWith('tokens_')));
  const sl = await mcp(pat.token, 'tools/call', {
    name: 'sessions_list',
    arguments: { showId: show.id },
  });
  const sessions = JSON.parse(sl.json?.result?.content?.[0]?.text ?? '[]');
  check(
    'tools/call sessions_list',
    sessions.some((s: any) => s.id === session.id),
    sl.text,
  );
  const ev = await mcp(pat.token, 'tools/call', {
    name: 'events_create',
    arguments: { sessionId: session.id, category: 'Note', message: 'from MCP', atSec: 12.5 },
  });
  check('tools/call events_create', !ev.json?.result?.isError, ev.text);
  const tp = await mcp(pat.token, 'tools/call', {
    name: 'topics_replace',
    arguments: {
      sessionId: session.id,
      topics: [
        { startSec: 0, durationSec: 60, title: 'Intro' },
        { startSec: 60, title: 'Main' },
      ],
    },
  });
  check('tools/call topics_replace', !tp.json?.result?.isError, tp.text);
  const bad = await mcp(pat.token, 'tools/call', { name: 'sessions_get', arguments: {} });
  check('invalid input → isError', bad.json?.result?.isError === true, bad.text);
  const pr = await mcp(pat.token, 'prompts/list');
  check('prompts/list', (pr.json?.result?.prompts ?? []).length >= 3, pr.text);
  const changes = await rpc<any[]>('changes.list', { sessionId: session.id }).catch(() => null);
  if (changes)
    check(
      'change log attributes MCP client',
      changes.some((c: any) => c.via === 'mcp' && c.clientName === 'smoke PAT'),
      changes.slice(0, 2),
    );
  const listed = await rpc<any[]>('tokens.list');
  check(
    'tokens.list shows PAT without secret',
    listed.some((t) => t.id === pat.apiToken.id) && !JSON.stringify(listed).includes(pat.token),
  );
  await rpc('tokens.revoke', { tokenId: pat.apiToken.id });
  const after = await mcp(pat.token, 'tools/list');
  check('revoked PAT → 401', after.status === 401);
}

// ── OAuth ──
const redirectUri = 'http://localhost:33418/callback';
const reg = await fetch(`${BASE}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'Smoke OAuth Client', redirect_uris: [redirectUri] }),
});
const client = (await reg.json()) as any;
check('register', reg.status === 201 && client.client_id, client);
const badReg = await fetch(`${BASE}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }),
});
check('register rejects non-loopback http', badReg.status === 400);

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authUrl = new URL(`${BASE}/oauth/authorize`);
for (const [k, v] of Object.entries({
  response_type: 'code',
  client_id: client.client_id,
  redirect_uri: 'http://localhost:40000/callback', // any loopback port
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: 'xyz',
  scope: 'autologger',
  resource: `${BASE}/mcp`,
}))
  authUrl.searchParams.set(k, v);
const authRes = await fetch(authUrl, { redirect: 'manual' });
const consent = new URL(authRes.headers.get('location') ?? '', BASE);
const requestId = consent.searchParams.get('request');
check(
  'authorize → consent redirect',
  authRes.status === 302 && consent.pathname === '/oauth/consent' && requestId,
  authRes.headers.get('location'),
);

const info = await fetch(`${BASE}/api/oauth/requests/${requestId}`, { headers: { cookie } }).then(
  (r) => r.json() as any,
);
check(
  'consent request info',
  info.ok &&
    info.data.clientName === 'Smoke OAuth Client' &&
    info.data.redirectHost === 'localhost:40000',
  info,
);
const noCookie = await fetch(`${BASE}/api/oauth/requests/${requestId}`);
check('consent info needs cookie', noCookie.status === 401);
const dec = await fetch(`${BASE}/api/oauth/requests/${requestId}/decision`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ approve: true }),
}).then((r) => r.json() as any);
const back = new URL(dec.data?.redirectTo ?? 'x:/');
const code = back.searchParams.get('code');
check(
  'approve → redirect with code + state',
  code && back.searchParams.get('state') === 'xyz',
  dec,
);

async function token(params: Record<string, string>, json = false) {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: json ? JSON.stringify(params) : new URLSearchParams(params),
  });
  return {
    status: res.status,
    cache: res.headers.get('cache-control'),
    body: (await res.json()) as any,
  };
}

const wrong = await token({
  grant_type: 'authorization_code',
  code: code!,
  code_verifier: 'x'.repeat(43),
  redirect_uri: 'http://localhost:40000/callback',
  client_id: client.client_id,
});
check(
  'wrong PKCE verifier → invalid_grant (and burns the code)',
  wrong.status === 400 && wrong.body.error === 'invalid_grant',
  wrong.body,
);

// Second round for the real exchange.
const auth2 = await fetch(authUrl, { redirect: 'manual' });
const req2 = new URL(auth2.headers.get('location')!, BASE).searchParams.get('request');
const dec2 = await fetch(`${BASE}/api/oauth/requests/${req2}/decision`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ approve: true }),
}).then((r) => r.json() as any);
const code2 = new URL(dec2.data.redirectTo).searchParams.get('code')!;
const tok = await token({
  grant_type: 'authorization_code',
  code: code2,
  code_verifier: verifier,
  redirect_uri: 'http://localhost:40000/callback',
  client_id: client.client_id,
  resource: `${BASE}/mcp`,
});
check(
  'code exchange',
  tok.status === 200 &&
    tok.body.access_token?.startsWith('alo_') &&
    tok.body.refresh_token?.startsWith('alr_') &&
    tok.cache === 'no-store',
  tok.body,
);
const replay = await token({
  grant_type: 'authorization_code',
  code: code2,
  code_verifier: verifier,
  redirect_uri: 'http://localhost:40000/callback',
  client_id: client.client_id,
});
check('code is single-use', replay.body.error === 'invalid_grant');

const viaOauth = await mcp(tok.body.access_token, 'tools/call', {
  name: 'sessions_get',
  arguments: { sessionId: session.id },
});
check(
  'MCP call with OAuth access token',
  !viaOauth.json?.result?.isError && viaOauth.status === 200,
  viaOauth.text,
);

const grants = await rpc<any[]>('tokens.list');
const grant = grants.find((g) => g.kind === 'oauth' && g.clientName === 'Smoke OAuth Client');
check('tokens.list shows the OAuth grant', grant, grants);

const ref = await token(
  {
    grant_type: 'refresh_token',
    refresh_token: tok.body.refresh_token,
    client_id: client.client_id,
  },
  true,
);
check(
  'refresh (JSON body) rotates',
  ref.status === 200 && ref.body.refresh_token !== tok.body.refresh_token,
  ref.body,
);
const newAccessWorks = await mcp(ref.body.access_token, 'tools/list');
check('new access token works', newAccessWorks.status === 200);
const reuse = await token({
  grant_type: 'refresh_token',
  refresh_token: tok.body.refresh_token,
  client_id: client.client_id,
});
check(
  'reusing old refresh token → invalid_grant',
  reuse.body.error === 'invalid_grant',
  reuse.body,
);
const afterReuse = await mcp(ref.body.access_token, 'tools/list');
check('reuse revoked the whole grant', afterReuse.status === 401);

// Fresh grant → revoke via /oauth/revoke.
const auth3 = await fetch(authUrl, { redirect: 'manual' });
const req3 = new URL(auth3.headers.get('location')!, BASE).searchParams.get('request');
const dec3 = await fetch(`${BASE}/api/oauth/requests/${req3}/decision`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ approve: true }),
}).then((r) => r.json() as any);
const tok3 = await token({
  grant_type: 'authorization_code',
  code: new URL(dec3.data.redirectTo).searchParams.get('code')!,
  code_verifier: verifier,
  redirect_uri: 'http://localhost:40000/callback',
  client_id: client.client_id,
});
const rv = await fetch(`${BASE}/oauth/revoke`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token: tok3.body.refresh_token, client_id: client.client_id }),
});
check('revoke → 200', rv.status === 200);
check(
  'revoked grant access token → 401',
  (await mcp(tok3.body.access_token, 'tools/list')).status === 401,
);

// Deny.
const auth4 = await fetch(authUrl, { redirect: 'manual' });
const req4 = new URL(auth4.headers.get('location')!, BASE).searchParams.get('request');
const dec4 = await fetch(`${BASE}/api/oauth/requests/${req4}/decision`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ approve: false }),
}).then((r) => r.json() as any);
const denied = new URL(dec4.data.redirectTo);
check(
  'deny → error=access_denied + state',
  denied.searchParams.get('error') === 'access_denied' &&
    denied.searchParams.get('state') === 'xyz',
);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
