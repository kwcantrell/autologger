// S3-compatible object storage (MinIO in compose). Server-side calls go to S3_ENDPOINT; presigned
// URLs handed to browsers are signed against S3_PUBLIC_ENDPOINT when set, because the host name
// must match the one the browser connects to.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { UploadPart, UploadTarget } from '@autologger/contract';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { unavailable } from '../core/errors.ts';
import { env, storageConfigured } from '../env.ts';

export const UPLOAD_URL_TTL_SEC = 15 * 60;
export const PLAYBACK_URL_TTL_SEC = 60 * 60;
/**
 * Files larger than this go up as a multipart upload in parts of this size (the last one smaller).
 * Storage may sit behind a proxy such as Cloudflare, which rejects request bodies over 100 MB
 * and times out slow ones (#357), so every PUT stays well under that.
 */
export const UPLOAD_PART_BYTES = 32 * 1024 ** 2;
/** Part URLs last longer than a single PUT's: a large file on a slow link takes hours. */
export const UPLOAD_PART_URL_TTL_SEC = 12 * 60 * 60;

function makeClient(endpoint: string | undefined): S3Client {
  return new S3Client({
    region: env.s3.region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: env.s3.forcePathStyle,
    credentials: {
      accessKeyId: env.s3.accessKeyId ?? '',
      secretAccessKey: env.s3.secretAccessKey ?? '',
    },
    // Newer SDKs add CRC32 checksum params to presigned PUTs, which browsers can't satisfy
    // and some S3-compatible servers reject. Only send checksums when the API requires them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

let serverClient: S3Client | null = null;
let publicClient: S3Client | null = null;

function server(): S3Client {
  serverClient ??= makeClient(env.s3.endpoint);
  return serverClient;
}

function browser(): S3Client {
  if (!env.s3.publicEndpoint || env.s3.publicEndpoint === env.s3.endpoint) return server();
  publicClient ??= makeClient(env.s3.publicEndpoint);
  return publicClient;
}

const bucket = () => env.s3.bucket!;

export function requireStorage(): void {
  if (!storageConfigured) {
    throw unavailable(
      'Media storage is not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (and S3_ENDPOINT for MinIO).',
    );
  }
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'video/quicktime': 'mov',
};

export function extForMime(mime: string, fileName?: string | null): string {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  const known = EXT_BY_MIME[base];
  if (known) return known;
  const fromName = fileName?.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  return fromName ? fromName.toLowerCase() : 'bin';
}

export function objectKeyFor(sessionId: string, segmentId: string, ext: string): string {
  return `sessions/${sessionId}/${segmentId}.${ext}`;
}

/** The waveform peaks object of a segment, next to its audio (see media/waveform.ts). */
export function peaksKeyFor(sessionId: string, segmentId: string): string {
  return `sessions/${sessionId}/${segmentId}.peaks.json`;
}

/** Every stored object of a session (audio, peaks) lives under this prefix. */
export function sessionPrefix(sessionId: string): string {
  return `sessions/${sessionId}/`;
}

/** The MP4 of a video compilation (compilations.*). */
export function compilationKeyFor(showId: string, compilationId: string): string {
  return `shows/${showId}/compilations/${compilationId}.mp4`;
}

/** A page body uploaded for wiki.upsert / wiki.patch (wiki.createUpload); removed once used. */
export function wikiUploadKeyFor(showId: string, uploadId: string): string {
  return `shows/${showId}/wiki-uploads/${uploadId}.md`;
}

/** Every stored object of a show itself (compilations, wiki uploads) lives under this prefix. */
export function showPrefix(showId: string): string {
  return `shows/${showId}/`;
}

let bucketReady: Promise<void> | null = null;

/** Create the bucket if it is missing. Errors (e.g. no permission) are logged and ignored. */
export function ensureBucket(): Promise<void> {
  if (!storageConfigured) return Promise.resolve();
  bucketReady ??= (async () => {
    try {
      await server().send(new HeadBucketCommand({ Bucket: bucket() }));
    } catch {
      try {
        await server().send(new CreateBucketCommand({ Bucket: bucket() }));
        console.log(`created bucket ${bucket()}`);
      } catch (e) {
        console.warn(`could not create bucket ${bucket()}: ${(e as Error).message}`);
      }
    }
  })();
  return bucketReady;
}

export async function presignUpload(key: string, contentType: string): Promise<string> {
  await ensureBucket();
  return getSignedUrl(
    browser(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    {
      expiresIn: UPLOAD_URL_TTL_SEC,
    },
  );
}

/**
 * Where a client PUTs a file of `sizeBytes` (unknown: one PUT): one presigned PUT up to
 * UPLOAD_PART_BYTES, else presigned part PUTs of a multipart upload. With `resume`, an unfinished
 * multipart upload of the same key and size is continued: its parts already stored come back
 * with `uploaded: true` and no URL (other unfinished uploads of the key are aborted). finishUpload
 * assembles the parts.
 */
export async function presignUploadTarget(
  key: string,
  contentType: string,
  sizeBytes?: number | null,
  resume = false,
): Promise<UploadTarget> {
  if (!sizeBytes || sizeBytes <= UPLOAD_PART_BYTES) {
    return {
      uploadUrl: await presignUpload(key, contentType),
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SEC * 1000).toISOString(),
    };
  }
  await ensureBucket();
  const plan = partPlan(sizeBytes);
  let uploadId: string | null = null;
  let stored = new Map<number, StoredPart>();
  for (const id of resume ? await multipartUploadsOf(key) : []) {
    const parts = await listParts(key, id);
    // Planned for another size (a different file), or an older attempt: drop it, don't mix parts.
    const fits = [...parts].every(([n, p]) => plan[n - 1]?.sizeBytes === p.size);
    if (!uploadId && fits) {
      uploadId = id;
      stored = parts;
    } else await abortMultipart(key, id);
  }
  uploadId ??= (
    await server().send(
      new CreateMultipartUploadCommand({
        Bucket: bucket(),
        Key: key,
        ContentType: contentType,
      }),
    )
  ).UploadId!;
  const parts: UploadPart[] = await Promise.all(
    plan.map(async (p) =>
      stored.has(p.partNumber)
        ? { ...p, uploaded: true }
        : {
            ...p,
            url: await getSignedUrl(
              browser(),
              new UploadPartCommand({
                Bucket: bucket(),
                Key: key,
                UploadId: uploadId,
                PartNumber: p.partNumber,
              }),
              { expiresIn: UPLOAD_PART_URL_TTL_SEC },
            ),
          },
    ),
  );
  return {
    headers: {},
    parts,
    expiresAt: new Date(Date.now() + UPLOAD_PART_URL_TTL_SEC * 1000).toISOString(),
  };
}

/** Parts of UPLOAD_PART_BYTES (the last one the rest), numbered from 1. */
export function partPlan(
  sizeBytes: number,
): { partNumber: number; offset: number; sizeBytes: number }[] {
  const out = [];
  for (let offset = 0, n = 1; offset < sizeBytes; offset += UPLOAD_PART_BYTES, n++)
    out.push({
      partNumber: n,
      offset,
      sizeBytes: Math.min(UPLOAD_PART_BYTES, sizeBytes - offset),
    });
  return out;
}

/**
 * Settle an upload from presignUploadTarget: the stored object's size once the file is complete
 * (assembling a multipart upload whose parts all arrived), `missing` part numbers when some
 * have not, or null when nothing arrived. `sizeBytes`: the size the upload was planned for, so
 * missing trailing parts are noticed (without it the parts must at least be contiguous).
 */
export async function finishUpload(
  key: string,
  sizeBytes?: number | null,
): Promise<{ size: number } | { missing: number[] } | null> {
  const [uploadId, ...older] = await multipartUploadsOf(key);
  if (!uploadId) {
    const head = await headObject(key);
    return head && head.size > 0 ? { size: head.size } : null;
  }
  const parts = await listParts(key, uploadId);
  const numbers = sizeBytes
    ? partPlan(sizeBytes).map((p) => p.partNumber)
    : Array.from({ length: Math.max(1, ...parts.keys()) }, (_, i) => i + 1);
  const missing = numbers.filter((n) => !parts.has(n));
  if (missing.length) return { missing };
  await server().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: numbers.map((n) => ({
          PartNumber: n,
          ETag: parts.get(n)!.etag,
        })),
      },
    }),
  );
  for (const id of older) await abortMultipart(key, id).catch(() => {});
  const head = await headObject(key);
  return head ? { size: head.size } : null;
}

/** In-progress multipart uploads of exactly this key, newest first. */
async function multipartUploadsOf(key: string): Promise<string[]> {
  const out: { id: string; at: number }[] = [];
  let keyMarker: string | undefined;
  let idMarker: string | undefined;
  do {
    const page = await server().send(
      new ListMultipartUploadsCommand({
        Bucket: bucket(),
        Prefix: key,
        KeyMarker: keyMarker,
        UploadIdMarker: idMarker,
      }),
    );
    for (const u of page.Uploads ?? [])
      if (u.Key === key && u.UploadId)
        out.push({ id: u.UploadId, at: u.Initiated?.getTime() ?? 0 });
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    idMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker);
  return out.sort((a, b) => b.at - a.at).map((u) => u.id);
}

type StoredPart = { size: number; etag: string };

/** Stored parts of a multipart upload by part number. */
async function listParts(key: string, uploadId: string): Promise<Map<number, StoredPart>> {
  const out = new Map<number, StoredPart>();
  let marker: string | undefined;
  do {
    const page = await server().send(
      new ListPartsCommand({
        Bucket: bucket(),
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: marker,
      }),
    );
    for (const p of page.Parts ?? [])
      if (p.PartNumber && p.ETag) out.set(p.PartNumber, { size: p.Size ?? 0, etag: p.ETag });
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (marker);
  return out;
}

async function abortMultipart(key: string, uploadId: string): Promise<void> {
  await server().send(
    new AbortMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
    }),
  );
}

/** Abort every unfinished multipart upload of a key (its parts are not objects: deleteObject misses them). */
export async function abortUploads(key: string): Promise<void> {
  for (const id of await multipartUploadsOf(key)) await abortMultipart(key, id);
}

/**
 * Abort unfinished multipart uploads under a prefix started before `before` (the media sweep):
 * abandoned uploads otherwise keep their parts in storage forever. Returns their keys (with
 * `dryRun`, the keys it would abort).
 */
export async function abortStaleUploads(
  prefix: string,
  before: Date,
  dryRun = false,
): Promise<string[]> {
  const out: string[] = [];
  let keyMarker: string | undefined;
  let idMarker: string | undefined;
  do {
    const page = await server().send(
      new ListMultipartUploadsCommand({
        Bucket: bucket(),
        Prefix: prefix,
        KeyMarker: keyMarker,
        UploadIdMarker: idMarker,
      }),
    );
    for (const u of page.Uploads ?? [])
      if (u.Key && u.UploadId && u.Initiated && u.Initiated < before) {
        if (!dryRun) await abortMultipart(u.Key, u.UploadId);
        out.push(u.Key);
      }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    idMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker);
  return out;
}

/** `downloadName`: answer with Content-Disposition attachment under that file name. */
export async function presignPlayback(key: string, downloadName?: string): Promise<string> {
  const disposition = downloadName
    ? `attachment; filename="${downloadName.replace(/[^\w .()-]+/g, '_')}"; filename*=UTF-8''${encodeURIComponent(downloadName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
    : undefined;
  return getSignedUrl(
    browser(),
    new GetObjectCommand({ Bucket: bucket(), Key: key, ResponseContentDisposition: disposition }),
    { expiresIn: PLAYBACK_URL_TTL_SEC },
  );
}

/** A presigned GET on the server's endpoint, for tools the worker runs (ffmpeg reads by URL). */
export async function presignServerGet(key: string): Promise<string> {
  return getSignedUrl(server(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: PLAYBACK_URL_TTL_SEC,
  });
}

/** Size of the object, or null when it does not exist. */
export async function headObject(
  key: string,
): Promise<{ size: number; contentType: string | null } | null> {
  try {
    const r = await server().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: r.ContentLength ?? 0, contentType: r.ContentType ?? null };
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      err.name === 'NotFound' ||
      err.name === 'NoSuchKey' ||
      err.$metadata?.httpStatusCode === 404
    )
      return null;
    throw e;
  }
}

export async function getObjectStream(
  key: string,
): Promise<{ body: ReadableStream<Uint8Array>; size: number | null }> {
  const r = await server().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!r.Body) throw new Error(`Object ${key} has no body.`);
  return {
    body: r.Body.transformToWebStream() as ReadableStream<Uint8Array>,
    size: r.ContentLength ?? null,
  };
}

/** A small object's bytes, or null when it does not exist. */
export async function getObjectBytes(key: string): Promise<Uint8Array | null> {
  try {
    const r = await server().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return r.Body ? await r.Body.transformToByteArray() : new Uint8Array();
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      err.name === 'NotFound' ||
      err.name === 'NoSuchKey' ||
      err.$metadata?.httpStatusCode === 404
    )
      return null;
    throw e;
  }
}

export async function putObjectFromFile(
  key: string,
  path: string,
  contentType: string,
): Promise<number> {
  await ensureBucket();
  const { size } = await stat(path);
  await server().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: createReadStream(path) as Readable,
      ContentLength: size,
      ContentType: contentType,
    }),
  );
  return size;
}

export async function putObjectBody(
  key: string,
  body: string | Uint8Array,
  contentType: string,
): Promise<void> {
  await ensureBucket();
  await server().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }),
  );
}

export async function deleteObject(key: string): Promise<void> {
  await server().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/** Delete every object under a key prefix; returns how many were deleted. */
export async function deletePrefix(prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const page = await server().send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }),
    );
    const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (keys.length) {
      // A page holds at most 1000 keys, the DeleteObjects limit.
      const r = await server().send(
        new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: keys, Quiet: true } }),
      );
      if (r.Errors?.length) {
        const e = r.Errors[0]!;
        throw new Error(
          `could not delete ${r.Errors.length} object(s), e.g. ${e.Key}: ${e.Message}`,
        );
      }
      deleted += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

/** The "folders" directly under a prefix ending in '/', e.g. `sessions/` → `sessions/<id>/`. */
export async function listChildPrefixes(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const page = await server().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: token,
      }),
    );
    for (const p of page.CommonPrefixes ?? []) if (p.Prefix) out.push(p.Prefix);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Every object under a prefix with its last-modified time (now when the server omits it). */
export async function listObjects(prefix: string): Promise<{ key: string; lastModified: Date }[]> {
  const out: { key: string; lastModified: Date }[] = [];
  let token: string | undefined;
  do {
    const page = await server().send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of page.Contents ?? [])
      if (o.Key) out.push({ key: o.Key, lastModified: o.LastModified ?? new Date() });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}
