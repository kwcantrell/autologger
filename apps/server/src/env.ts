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
  /** Jobs a worker process runs in parallel (the API also uses it for jobs.list etaSec). */
  workerConcurrency: Math.max(1, Number(str('WORKER_CONCURRENCY', '2')) || 1),
};

export const isProd = env.nodeEnv === 'production';
export const googleConfigured = Boolean(env.google.clientId && env.google.clientSecret);
export const storageConfigured = Boolean(
  env.s3.bucket && env.s3.accessKeyId && env.s3.secretAccessKey,
);
export const transcriptionConfigured = Boolean(env.deepgramApiKey) && storageConfigured;
