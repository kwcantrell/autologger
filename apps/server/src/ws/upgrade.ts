// Routes HTTP upgrade requests to WebSocket handlers by path prefix.

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';

export type WsHandler = (ws: WebSocket, req: IncomingMessage, url: URL) => void | Promise<void>;
/** Runs before the upgrade completes; return false (or an HTTP status) to reject. */
export type WsGuard = (req: IncomingMessage, url: URL) => Promise<boolean | number>;

const routes: { prefix: string; guard?: WsGuard; handler: WsHandler }[] = [];

export function registerWs(prefix: string, handler: WsHandler, guard?: WsGuard): void {
  routes.push({ prefix, handler, guard });
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

function reject(socket: Duplex, status: number) {
  const text = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found';
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachWebSockets(server: Server): void {
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = routes.find((r) => url.pathname.startsWith(r.prefix));
    if (!route) return reject(socket, 404);
    try {
      if (route.guard) {
        const ok = await route.guard(req, url);
        if (ok !== true) return reject(socket, typeof ok === 'number' ? ok : 403);
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        Promise.resolve(route.handler(ws, req, url)).catch((e) => {
          console.error('ws handler failed', e);
          ws.close(1011);
        });
      });
    } catch (e) {
      console.error('ws upgrade failed', e);
      reject(socket, 500);
    }
  });
}

/** Keep sockets alive through proxies and drop dead peers. */
export function heartbeat(ws: WebSocket, intervalMs = 25_000): () => void {
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const t = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, intervalMs);
  return () => clearInterval(t);
}
