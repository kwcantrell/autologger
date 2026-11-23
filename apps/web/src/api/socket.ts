// One reconnecting live socket, shared by the session (/ws/session/:id) and show (/ws/show/:id)
// sockets: capped exponential backoff with jitter, keep-alive pings, an immediate retry when the
// browser comes back online, and the server's terminal close codes. What a message means is the
// caller's business.

export type LiveStatus =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'reconnecting'; attempt: number }
  | { state: 'closed'; reason: 'access_revoked' | 'deleted' | 'unauthenticated' };

/** The show socket can also give up on its own (polling takes over). */
export type ShowLiveStatus = LiveStatus | { state: 'closed'; reason: 'unavailable' };

type ServerMessage = { type: string };
type ClosedMessage = { type: 'closed'; reason: 'access_revoked' | 'deleted' };

export interface LiveSocketOptions<M extends ServerMessage> {
  /** Absolute ws(s):// URL. */
  url: string;
  onStatus: (status: ShowLiveStatus) => void;
  /**
   * The server is listening: pushes reach us only from now on, so catch up on what may have been
   * missed. `reconnect` is false for the first hello of this socket; `connectedAt` is when the
   * current connection attempt started.
   */
  onHello: (m: M, ctx: { reconnect: boolean; connectedAt: number }) => void;
  /** Every other message except `closed`. */
  onMessage: (m: M) => void;
  /** The server closed the subscription for good (access revoked, deleted). */
  onClosed?: (reason: ClosedMessage['reason']) => void;
  /**
   * Asked after the second failed reconnect in a row. A resource deleted or unshared while we were
   * offline is refused at the upgrade with an HTTP status, which the browser reports as a plain
   * 1006 close: return 'gone' or 'unauthenticated' to stop reconnecting, null to keep trying.
   */
  probe?: () => Promise<'gone' | 'unauthenticated' | null>;
  /**
   * Stop retrying (status `unavailable`) after this many attempts in a row that never got a
   * hello. The browser coming back online still tries again.
   */
  maxFailedConnects?: number;
}

const PING_MS = 25_000;
const MAX_BACKOFF_MS = 15_000;
/** App close codes: signed out, forbidden, not found. */
const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_TERMINAL = [4403, 4404];

export const backoffMs = (attempt: number, random = Math.random()) =>
  Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempt, 5)) * (0.75 + random * 0.5);

export function liveUrl(path: string) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

/** Opens the socket now; `dispose` closes it and stops reconnecting. */
export function createLiveSocket<M extends ServerMessage>(opts: LiveSocketOptions<M>) {
  let ws: WebSocket | null = null;
  let disposed = false;
  let terminal = false;
  let attempt = 0;
  let failedConnects = 0;
  let gotHello = false;
  let everHello = false;
  let connectedAt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const stop = (status: ShowLiveStatus | null) => {
    terminal = true;
    clearTimeout(retryTimer);
    if (status) opts.onStatus(status);
  };

  const runProbe = async () => {
    const verdict = await opts.probe?.().catch(() => null);
    if (disposed || terminal || !verdict) return;
    stop(verdict === 'unauthenticated' ? { state: 'closed', reason: 'unauthenticated' } : null);
  };

  const connect = () => {
    if (disposed) return;
    connectedAt = Date.now();
    gotHello = false;
    const socket = new WebSocket(opts.url);
    ws = socket;
    socket.onmessage = (ev) => {
      let m: M;
      try {
        m = JSON.parse(String(ev.data)) as M;
      } catch {
        return;
      }
      if (m.type === 'hello') {
        const reconnect = everHello || attempt > 0;
        gotHello = everHello = true;
        failedConnects = 0;
        attempt = 0;
        opts.onHello(m, { reconnect, connectedAt });
        opts.onStatus({ state: 'open' });
        return;
      }
      if (m.type === 'closed') {
        const { reason } = m as unknown as ClosedMessage;
        stop({ state: 'closed', reason });
        opts.onClosed?.(reason);
        return;
      }
      opts.onMessage(m);
    };
    socket.onopen = () => {
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, PING_MS);
    };
    socket.onclose = (ev) => {
      clearInterval(pingTimer);
      if (disposed || terminal) return;
      if (ev.code === CLOSE_UNAUTHENTICATED) {
        stop({ state: 'closed', reason: 'unauthenticated' });
        return;
      }
      if (CLOSE_TERMINAL.includes(ev.code)) return;
      failedConnects = gotHello ? 0 : failedConnects + 1;
      if (opts.maxFailedConnects && failedConnects >= opts.maxFailedConnects) {
        // Stop retrying on a timer, but not for good: coming back online tries again.
        opts.onStatus({ state: 'closed', reason: 'unavailable' });
        return;
      }
      attempt += 1;
      opts.onStatus({ state: 'reconnecting', attempt });
      if (attempt >= 2) void runProbe();
      retryTimer = setTimeout(connect, backoffMs(attempt));
    };
  };

  // Waiting out a backoff: try again now.
  const onOnline = () => {
    if (ws?.readyState === WebSocket.CLOSED && !terminal && !disposed) {
      clearTimeout(retryTimer);
      connect();
    }
  };

  opts.onStatus({ state: 'connecting' });
  connect();
  window.addEventListener('online', onOnline);

  return {
    dispose() {
      disposed = true;
      window.removeEventListener('online', onOnline);
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      ws?.close();
    },
  };
}
