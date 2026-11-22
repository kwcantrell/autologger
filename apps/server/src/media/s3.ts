// S3-compatible object storage (MinIO in compose). Server-side calls go to S3_ENDPOINT; presigned
// URLs handed to browsers are signed against S3_PUBLIC_ENDPOINT when set, because the host name
// must match the one the browser connects to.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { unavailable } from '../core/errors.ts';
import { env, storageConfigured } from '../env.ts';

export const UPLOAD_URL_TTL_SEC = 15 * 60;
export const PLAYBACK_URL_TTL_SEC = 60 * 60;

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

export async function presignPlayback(key: string): Promise<string> {
  return getSignedUrl(browser(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
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

export async function deleteObject(key: string): Promise<void> {
  await server().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
