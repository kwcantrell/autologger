// All configuration comes from the environment. Optional integrations stay off when unset,
// and the ops that need them answer `unavailable`.

const str = (k: string, d?: string): string | undefined => {
  const v = process.env[k]?.trim();
  return v ? v : d;
};

const list = (k: string): string[] =>
  (str(k) ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const workerConcurrency = Math.max(1, Math.floor(Number(str('WORKER_CONCURRENCY', '2'))) || 1);
const kindConcurrency = (k: string, fallback = workerConcurrency): number =>
  Math.min(workerConcurrency, Math.max(1, Math.floor(Number(str(k)))) || fallback);

export const env = {
  nodeEnv: str('NODE_ENV', 'development')!,
  port: Number(str('PORT', '8080')),
  databaseUrl: str('DATABASE_URL', 'postgres://autologger:autologger@localhost:5432/autologger')!,
  /** Origin users and agents reach the app at (OAuth redirects, MCP resource id). */
  publicUrl: str('PUBLIC_URL', 'http://localhost:8080')!.replace(/\/$/, ''),
  /** Built SPA to serve; unset in dev (Vite serves the web app and proxies /api). */
  webDist: str('WEB_DIST'),

  google: {
    clientId: str('GOOGLE_CLIENT_ID'),
    clientSecret: str('GOOGLE_CLIENT_SECRET'),
  },
  /** Dev-only email login without Google. Never enable in production. */
  devLogin: str('DEV_LOGIN') === '1',
  /**
   * Public landing page for signed-out visitors at `/` (default on). LANDING_PAGE=0 sends them
   * straight to sign-in instead, e.g. for a private self-hosted instance.
   */
  landingPage: str('LANDING_PAGE', '1') === '1',
  /** Emails that become active superadmins on first sign-in. */
  superadminEmails: list('SUPERADMIN_EMAILS'),

  s3: {
    endpoint: str('S3_ENDPOINT'),
    /** Endpoint browsers use for presigned URLs, when different from the server's. */
    publicEndpoint: str('S3_PUBLIC_ENDPOINT'),
    region: str('S3_REGION', 'us-east-1')!,
    bucket: str('S3_BUCKET'),
    accessKeyId: str('S3_ACCESS_KEY_ID'),
    secretAccessKey: str('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: str('S3_FORCE_PATH_STYLE', '1') === '1',
  },
  deepgramApiKey: str('DEEPGRAM_API_KEY'),
  ytDlpPath: str('YTDLP_PATH', 'yt-dlp')!,
  youtubeEnabled: str('YOUTUBE_IMPORT', '1') === '1',
  /** ffmpeg for waveform peaks (worker). Missing → waveform jobs are skipped with a note. */
  ffmpegPath: str('FFMPEG_PATH', 'ffmpeg')!,
  /**
   * Jobs a worker process runs in parallel. Workers report it in their `workers` heartbeat row;
   * the API uses its own value for etaSec only when no worker row is live.
   */
  workerConcurrency,
  /**
   * Per job kind, how many of a worker's slots it may fill at once (WORKER_CONCURRENCY_<KIND>,
   * 1 up to workerConcurrency, which is also the default; waveform and compile default to 1).
   */
  workerKindConcurrency: {
    transcribe: kindConcurrency('WORKER_CONCURRENCY_TRANSCRIBE'),
    youtube_import: kindConcurrency('WORKER_CONCURRENCY_YOUTUBE_IMPORT'),
    // Cosmetic work: one slot by default, so it never crowds out imports and transcriptions.
    waveform: kindConcurrency('WORKER_CONCURRENCY_WAVEFORM', 1),
    // Video compilations download and re-encode video: heavy, one at a time by default.
    compile: kindConcurrency('WORKER_CONCURRENCY_COMPILE', 1),
  },
};

export const isProd = env.nodeEnv === 'production';
export const googleConfigured = Boolean(env.google.clientId && env.google.clientSecret);
export const storageConfigured = Boolean(
  env.s3.bucket && env.s3.accessKeyId && env.s3.secretAccessKey,
);
export const transcriptionConfigured = Boolean(env.deepgramApiKey) && storageConfigured;
