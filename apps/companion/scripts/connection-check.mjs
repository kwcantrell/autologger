// Drives the built module's CompanionConnection against a running dev server (DEV_LOGIN=1):
// connect, get state, roll, log, stop, then revoke → bad_token.
//   npm run build && node scripts/connection-check.mjs http://localhost:18084
import { CompanionConnection } from '../dist/connection.js';
import { liveState, socketUrl, toVariableValues } from '../dist/state.js';

const base = process.argv[2] ?? 'http://localhost:18084';
let cookie = '';
async function rpc(path, body) {
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
await rpc('/auth/dev-login', { email: 'owner@example.com' });
const team = await rpc('/api/rpc/teams.create', { name: `Conn check ${Date.now()}` });
const show = await rpc('/api/rpc/shows.create', { teamId: team.id, name: 'Conn show' });
await rpc('/api/rpc/sessions.create', { showId: show.id, title: 'Conn session' });
const { device, token } = await rpc('/api/rpc/companion.create', {
  showId: show.id,
  name: 'Module',
});

const statuses = [];
let latest = null;
const conn = new CompanionConnection(socketUrl(base), token, {
  onState: (s, t) => {
    latest = liveState(s, t, Date.now());
  },
  onStatus: (s, m) => statuses.push(m ? `${s}: ${m}` : s),
});
conn.start();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(500);
console.log('vars on connect', toVariableValues(latest, Date.now()));
await conn.request('transport.start');
await wait(1200);
const cat = latest.state.categories[0];
await conn.request('events.create', { categoryId: cat.id, message: 'module check' });
await wait(200);
console.log('vars rolling', toVariableValues(latest, Date.now()));
await conn.request('transport.stop');
await rpc('/api/rpc/companion.revoke', { deviceId: device.id });
await wait(500);
console.log('statuses', statuses);
conn.stop();
await rpc('/api/rpc/teams.delete', { teamId: team.id }).catch(() => {});
process.exit(statuses.at(-1)?.startsWith('bad_token') ? 0 : 1);
