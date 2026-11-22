// End-to-end smoke test of /ws/companion against a running dev server (DEV_LOGIN=1).
//   node apps/companion/scripts/smoke.mjs http://localhost:18084
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://localhost:18084';
let cookie = '';
async function http(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body ?? {}),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const json = await res.json();
  if (!json.ok) throw new Error(`${path}: ${JSON.stringify(json.error)}`);
  return json.data;
}
const rpc = (op, input) => http(`/api/rpc/${op}`, input);
const assert = (c, m) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok - ${m}`);
};

await http('/auth/dev-login', { email: 'owner@example.com' });
const team = await rpc('teams.create', { name: `Companion smoke ${Date.now()}` });
const show = await rpc('shows.create', { teamId: team.id, name: 'Smoke show' });
const s1 = await rpc('sessions.create', { showId: show.id, title: 'First' });
const s2 = await rpc('sessions.create', { showId: show.id, title: 'Second' });
const cats = await rpc('categories.list', { showId: show.id });
const { device, token } = await rpc('companion.create', { showId: show.id, name: 'Deck 1' });
assert(token.startsWith('ald_'), 'token issued');

// Bad token is rejected at upgrade.
await new Promise((resolve) => {
  const bad = new WebSocket(`${base.replace('http', 'ws')}/ws/companion?token=ald_nope`);
  bad.on('unexpected-response', (_req, res) => {
    assert(res.statusCode === 401, 'bad token → 401');
    resolve();
  });
  bad.on('error', () => {});
});

const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/companion`, {
  headers: { authorization: `Bearer ${token}` },
});
const queue = [];
ws.on('message', (raw) => queue.push(JSON.parse(String(raw))));
const closed = new Promise((r) =>
  ws.on('close', (code, reason) => r({ code, reason: String(reason) })),
);
async function next(pred, label, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const i = queue.findIndex(pred);
    if (i >= 0) return queue.splice(i, 1)[0];
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
let req = 0;
const op = (o, input) => {
  const reqId = String(++req);
  ws.send(JSON.stringify({ type: 'op', reqId, op: o, input }));
  return next((m) => m.type === 'result' && m.reqId === reqId, `result ${o}`);
};

let st = await next((m) => m.type === 'state', 'initial state');
assert(st.state.session?.id === s2.id, 'initial state targets newest session');
assert(st.state.categories.length === cats.length && cats.length > 0, 'state carries categories');
const listed = await rpc('companion.list', { showId: show.id });
assert(listed[0]?.online === true, 'device listed online');

let r = await op('transport.start', {});
assert(r.ok && r.data.isRolling, 'transport.start result');
st = await next((m) => m.type === 'state' && m.state.session?.isRolling, 'rolling state');
assert(st.state.session.take === 1, 'state push isRolling take 1');

r = await op('events.create', { categoryId: cats[0].id, message: 'from deck' });
assert(r.ok && r.data.source === 'companion', 'events.create result (source companion)');
st = await next(
  (m) => m.type === 'state' && m.state.lastEvent?.id === r.data.id,
  'lastEvent state',
);
assert(st.state.session.eventCount === 1, 'state lastEvent + eventCount');

r = await op('sessions.delete', { sessionId: s1.id });
assert(!r.ok && r.error.code === 'not_found', 'non-companion op rejected');

await rpc('companion.setTarget', { deviceId: device.id, sessionId: s1.id });
st = await next((m) => m.type === 'state' && m.state.session?.id === s1.id, 'retarget state');
assert(!st.state.session.isRolling, 'setTarget → new state for first session');
r = await op('transport.start', {});
assert(r.ok && r.data.id === s1.id, 'ops now default to new target');
await next(
  (m) => m.type === 'state' && m.state.session?.id === s1.id && m.state.session.isRolling,
  'rolling s1',
);

await rpc('companion.revoke', { deviceId: device.id });
const c = await closed;
assert(c.code === 4403, `revoke closes socket (${c.code} ${c.reason})`);
const after = await rpc('companion.list', { showId: show.id });
assert(after.length === 0, 'revoked device not listed');

await rpc('transport.stop', { sessionId: s1.id });
await rpc('transport.stop', { sessionId: s2.id });
await rpc('teams.delete', { teamId: team.id }).catch(() => {});
console.log('all good');
process.exit(0);
