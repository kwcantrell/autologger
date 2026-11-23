import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Session, SessionServerMessage } from '@autologger/contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createAuthSession, SESSION_COOKIE } from '../http/auth.ts';
import { withViewerAccess } from '../ws/session.ts';
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

/** Opens /ws/session/:id as the user and waits for hello. */
async function connect(userId: string, sessionId: string) {
  const cookie = `${SESSION_COOKIE}=${await createAuthSession(userId)}`;
  const ws = new WebSocket(`${base}/ws/session/${sessionId}`, { headers: { cookie } });
  const got: SessionServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (raw) => {
    got.push(JSON.parse(String(raw)) as SessionServerMessage);
    for (const w of waiters.splice(0)) w();
  });
  const next = (pred: (m: SessionServerMessage) => boolean) =>
    new Promise<SessionServerMessage>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(got)}`)), 2000);
      const check = () => {
        const i = got.findIndex(pred);
        if (i === -1) return void waiters.push(check);
        clearTimeout(t);
        resolve(got.splice(0, i + 1).pop()!);
      };
      check();
    });
  await next((m) => m.type === 'hello');
  return { ws, next };
}

describe('/ws/session/:id', () => {
  it('leaves messages without a session payload alone', () => {
    const m = { type: 'invalidate', entity: 'event' } as const;
    expect(withViewerAccess(m, 'read')).toBe(m);
  });

  it("sends each viewer their own access on session pushes, not the writer's", async () => {
    const { owner, team, show, session } = await studio();
    const reader = await makeUser('reader@example.com');
    await call(owner, 'teams.invite', { teamId: team.id, email: 'reader@example.com' });
    const grant = (access: 'read' | 'write') =>
      call(owner, 'teams.setGrant', {
        teamId: team.id,
        userId: reader.user.id,
        showId: show.id,
        access,
      });
    await grant('read');

    const live = await connect(reader.user.id, session.id);
    await call(owner, 'transport.start', { sessionId: session.id });
    const transport = await live.next((m) => m.type === 'transport');
    expect(transport.type === 'transport' && transport.session.access).toBe('read');
    const change = await live.next((m) => m.type === 'change' && m.entity === 'session');
    expect(change.type === 'change' && (change.data as Session).access).toBe('read');

    // A changed grant: the client is told to refetch, and later pushes carry the new level.
    await grant('write');
    await live.next((m) => m.type === 'invalidate' && m.entity === 'session');
    await call(owner, 'transport.stop', { sessionId: session.id });
    const after = await live.next((m) => m.type === 'transport');
    expect(after.type === 'transport' && after.session.access).toBe('write');
    live.ws.close();
  });
});
