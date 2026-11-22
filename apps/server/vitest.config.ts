import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Ops tests share one Postgres database; run files one at a time.
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://autologger:autologger@localhost:54329/autologger_test',
      DEV_LOGIN: '0',
      SUPERADMIN_EMAILS: '',
      S3_BUCKET: '',
      DEEPGRAM_API_KEY: '',
    },
  },
});
