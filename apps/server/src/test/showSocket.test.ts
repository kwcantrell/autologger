import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ShowServerMessage } from '@autologger/contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { changeMessage, publish } from '../core/bus.ts';
import { createAuthSession, SESSION_COOKIE } from '../http/auth.ts';
import { EVENT_HINT_MS } from '../ws/show.ts';
import { attachWebSockets } from '../ws/upgrade.ts';
import { call, makeUser, resetDb, setupDb, studio } from './harness.ts';

let server: Server;
let base: string;

beforeAll(async () => {
  await setupDb();
  server = createServer();
  attachWebSockets(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(resetDb);

/** Opens /ws/show/:id as the user; resolves once the socket answers (hello or HTTP status). */
async function connect(userId: string, showId: string) {
  const cookie = `${SESSION_COOKIE}=${await createAuthSession(userId)}`;
  const ws = new WebSocket(`${base}/ws/show/${showId}`, { headers: { cookie } });
  const got: ShowServerMessage[] = [];
  const waiters: (() => void)[] = [];
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  ws.on('message', (raw) => {
    got.push(JSON.parse(String(raw)) as ShowServerMessage);
    for (const w of waiters.splice(0)) w();
  });
  const status = await new Promise<number>((resolve) => {
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    waiters.push(() => resolve(101));
  });
  /** Waits for a message matching `pred` (or fails after 2 s). */
  const next = (pred: (m: ShowServerMessage) => boolean) =>
    new Promise<ShowServerMessage>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(got)}`)), 2000);
      const check = () => {
        const i = got.findIndex(pred);
        if (i === -1) return void waiters.push(check);
        clearTimeout(t);
        resolve(got.splice(0, i + 1).pop()!);
      };
      check();
    });
  return { ws, status, got, next, closed };
}

describe('/ws/show/:id', () => {
  it("pushes the show's job and session-list changes, and only to readers", async () => {
    const { owner, team, show, session } = await studio();
    const other = await call(owner, 'shows.create', { teamId: team.id, name: 'Other' });
    const elsewhere = await call(owner, 'sessions.create', { showId: other.id });

    const outsider = await makeUser('outsider@example.com');
    const denied = await connect(outsider.user.id, show.id);
    expect(denied.status).toBe(404);

    const live = await connect(owner.user.id, show.id);
    expect(live.status).toBe(101);
    expect(live.got.shift()).toMatchObject({ type: 'hello', showId: show.id });

    // As the worker publishes them: on the session topic only. Another show's job is not sent.
    const job = { id: 'job_x', status: 'running', progress: 'Downloading' };
    publish(`session:${elsewhere.id}`, changeMessage('job', 'upsert', 'job_other', job));
    publish(`session:${session.id}`, changeMessage('job', 'upsert', job.id, job));
    const pushed = await live.next((m) => m.type === 'change');
    expect(pushed).toEqual({ type: 'change', entity: 'job', op: 'upsert', id: 'job_x', data: job });

    // Sessions created (e.g. by an agent) and deleted elsewhere.
    const created = await call(owner, 'sessions.create', { showId: show.id });
    await live.next((m) => m.type === 'invalidate' && m.entity === 'session');
    await call(owner, 'sessions.delete', { sessionId: created.id });
    await live.next((m) => m.type === 'invalidate' && m.entity === 'session');
    // Its jobs were deleted with it.
    await live.next((m) => m.type === 'invalidate' && m.entity === 'job');
    expect(live.got.some((m) => m.type === 'change')).toBe(false);

    await call(owner, 'shows.delete', { showId: show.id });
    await live.next((m) => m.type === 'closed' && m.reason === 'deleted');
    live.ws.close();
  });

  it("throttles event changes of the show's sessions into session-list hints", async () => {
    const { owner, show, session } = await studio();
    const live = await connect(owner.user.id, show.id);
    expect(live.got.shift()).toMatchObject({ type: 'hello' });

    // A burst of logged events: one hint at once, one trailing hint after the window.
    const event = { id: 'evt_x' };
    for (let i = 0; i < 5; i++)
      publish(`session:${session.id}`, changeMessage('event', 'upsert', `evt_${i}`, event));
    await live.next((m) => m.type === 'invalidate' && m.entity === 'session');
    await new Promise((r) => setTimeout(r, EVENT_HINT_MS - 500));
    expect(live.got).toEqual([]);
    await new Promise((r) => setTimeout(r, 1000));
    expect(live.got).toEqual([{ type: 'invalidate', entity: 'session' }]);
    live.ws.close();
  }, 10_000);

  it('closes with 4403 when the reader loses access to the show', async () => {
    const { owner, team, show } = await studio();
    const member = await makeUser('member@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: 'member@example.com' });
    const grant = { teamId: team.id, userId: member.user.id, showId: show.id };
    await call(owner, 'teams.setGrant', { ...grant, access: 'read' });

    const live = await connect(member.user.id, show.id);
    expect(live.status).toBe(101);
    await call(owner, 'teams.setGrant', { ...grant, access: 'none' });
    await live.next((m) => m.type === 'closed' && m.reason === 'access_revoked');
    expect(await live.closed).toBe(4403);
  });
});
