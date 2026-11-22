// Realtime fan-out. Publishes in-process and through Postgres NOTIFY so that writes made by the
// worker (or another app instance) reach this process's WebSocket clients.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { LiveEntity, SessionServerMessage } from '@autologger/contract';
import { sqlClient } from '../db/client.ts';

/** Topics: `session:<id>`, `show:<id>` (categories etc.), `user:<id>` (access changes). */
export type Topic = `session:${string}` | `show:${string}` | `user:${string}`;

export type BusMessage =
  | SessionServerMessage
  | { type: 'access_changed'; userId: string }
  | { type: 'show_changed'; showId: string; entity: 'category' | 'show' | 'device' };

const CHANNEL = 'autologger';
const ORIGIN = randomUUID();
const MAX_NOTIFY = 7000;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
let listening = false;

export function subscribe(topic: Topic, fn: (m: BusMessage) => void): () => void {
  emitter.on(topic, fn);
  return () => emitter.off(topic, fn);
}

export function publish(topic: Topic, message: BusMessage): void {
  emitter.emit(topic, message);
  let payload = JSON.stringify({ o: ORIGIN, t: topic, m: message });
  if (payload.length > MAX_NOTIFY && message.type === 'change') {
    const slim: SessionServerMessage = { type: 'invalidate', entity: message.entity };
    payload = JSON.stringify({ o: ORIGIN, t: topic, m: slim });
  }
  if (payload.length > MAX_NOTIFY) return;
  sqlClient.notify(CHANNEL, payload).catch((e) => console.error('notify failed', e));
}

/** Helper for the common "row changed in a session" message. */
export function changeMessage(
  entity: LiveEntity,
  op: 'upsert' | 'delete',
  id: string,
  data?: unknown,
): SessionServerMessage {
  return { type: 'change', entity, op, id, ...(data === undefined ? {} : { data }) };
}

/** Start receiving NOTIFYs from other processes. Call once at boot. */
export async function listenForRemote(): Promise<void> {
  if (listening) return;
  listening = true;
  await sqlClient.listen(CHANNEL, (raw) => {
    try {
      const { o, t, m } = JSON.parse(raw) as { o: string; t: Topic; m: BusMessage };
      if (o !== ORIGIN) emitter.emit(t, m);
    } catch {
      /* ignore malformed */
    }
  });
}
