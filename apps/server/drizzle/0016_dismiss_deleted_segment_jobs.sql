-- Custom SQL migration file, put your code below! --
-- Failed transcribe/waveform jobs of audio segments deleted before media.delete dismissed them:
-- dismiss them so they stop being reported as open failures.
UPDATE "jobs" SET "dismissed_at" = "updated_at"
WHERE "kind" IN ('transcribe', 'waveform') AND "status" = 'failed' AND "dismissed_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "audio_segments" s WHERE s."id" = "jobs"."payload"->>'segmentId');
