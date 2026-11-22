// Audio uploads: media.createUpload → PUT to the presigned URL → media.completeUpload.
// A small in-memory queue retries failed segments with backoff; the UI subscribes to it to show
// pending/failed counts and to warn before the tab closes with unsent audio.

import { RpcError, rpc } from '@/api/rpc';
import { createStore } from '@/lib/store';

export interface PendingUpload {
  key: string;
  sessionId: string;
  blob: Blob;
  mimeType: string;
  origin: 'recorded' | 'file';
  fileName?: string;
  startSec?: number;
  durationSec?: number;
  attempts: number;
  state: 'queued' | 'uploading' | 'failed';
  error: string | null;
  /** Server segment id once createUpload succeeded (so a retry re-PUTs the same slot). */
  segmentId?: string;
  uploadUrl?: string;
  headers?: Record<string, string>;
  progress: number;
}

export const uploadQueue = createStore<PendingUpload[]>([]);

const MAX_AUTO_ATTEMPTS = 5;
let seq = 0;
let running = false;

function patch(key: string, p: Partial<PendingUpload>) {
  uploadQueue.set((list) => list.map((u) => (u.key === key ? { ...u, ...p } : u)));
}
function remove(key: string) {
  uploadQueue.set((list) => list.filter((u) => u.key !== key));
}

/** PUT with progress (XHR: fetch has no upload progress). */
function put(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  onProgress: (f: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Storage answered ${xhr.status} to the upload.`));
    xhr.onerror = () =>
      reject(
        new Error(
          "Couldn't reach the storage server. The upload will be retried; check the connection (or the storage CORS setup).",
        ),
      );
    xhr.send(blob);
  });
}

async function uploadOne(u: PendingUpload): Promise<void> {
  patch(u.key, { state: 'uploading', error: null, attempts: u.attempts + 1 });
  let { segmentId, uploadUrl, headers } = u;
  if (!segmentId || !uploadUrl) {
    const created = await rpc('media.createUpload', {
      sessionId: u.sessionId,
      mimeType: u.mimeType,
      origin: u.origin,
      fileName: u.fileName,
      startSec: u.startSec,
      sizeBytes: u.blob.size || undefined,
    });
    segmentId = created.segment.id;
    uploadUrl = created.uploadUrl;
    headers = created.headers;
    patch(u.key, { segmentId, uploadUrl, headers });
  }
  await put(uploadUrl, u.blob, headers ?? {}, (f) => patch(u.key, { progress: f }));
  await rpc('media.completeUpload', {
    segmentId,
    durationSec:
      u.durationSec != null && Number.isFinite(u.durationSec)
        ? Math.max(0, u.durationSec)
        : undefined,
  });
}

function retryable(e: unknown) {
  return !(e instanceof RpcError) || ['network', 'internal', 'conflict'].includes(e.code);
}

async function drain() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = uploadQueue.get().find((u) => u.state === 'queued');
      if (!next) break;
      try {
        await uploadOne(next);
        remove(next.key);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const cur = uploadQueue.get().find((u) => u.key === next.key);
        const attempts = cur?.attempts ?? next.attempts + 1;
        // A presigned URL may have expired: start over with a fresh slot only if create failed.
        if (retryable(e) && attempts < MAX_AUTO_ATTEMPTS) {
          patch(next.key, { state: 'failed', error: msg });
          const delay = Math.min(30_000, 1000 * 2 ** attempts);
          setTimeout(() => {
            if (uploadQueue.get().some((u) => u.key === next.key && u.state === 'failed')) {
              patch(next.key, { state: 'queued' });
              void drain();
            }
          }, delay);
        } else {
          patch(next.key, { state: 'failed', error: msg });
        }
      }
    }
  } finally {
    running = false;
  }
}

export function enqueueUpload(
  u: Omit<PendingUpload, 'key' | 'attempts' | 'state' | 'error' | 'progress'>,
) {
  const key = `up${++seq}`;
  uploadQueue.set((list) => [
    ...list,
    { ...u, key, attempts: 0, state: 'queued', error: null, progress: 0 },
  ]);
  void drain();
  return key;
}

export function retryUpload(key: string) {
  patch(key, { state: 'queued', attempts: 0 });
  void drain();
}

export function discardUpload(key: string) {
  remove(key);
}

export function downloadUpload(u: PendingUpload) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(u.blob);
  a.download =
    u.fileName ??
    `recording-${u.key}.${u.mimeType.includes('ogg') ? 'ogg' : u.mimeType.includes('mp4') ? 'm4a' : 'webm'}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Duration of an audio file in seconds via a throwaway <audio>, or undefined. */
export function probeDuration(blob: Blob): Promise<number | undefined> {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (v: number | undefined) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      if (Number.isFinite(a.duration)) return done(a.duration);
      // Chrome reports Infinity for MediaRecorder webm until it seeks to the end.
      a.currentTime = 1e9;
      a.ontimeupdate = () => {
        a.ontimeupdate = null;
        done(Number.isFinite(a.duration) ? a.duration : undefined);
      };
    };
    a.onerror = () => done(undefined);
    setTimeout(() => done(undefined), 8000);
    a.src = url;
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (uploadQueue.get().length > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}
