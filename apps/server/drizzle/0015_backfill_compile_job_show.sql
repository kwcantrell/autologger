-- Custom SQL migration file, put your code below! --
-- Compile jobs queued before jobs.show_id existed: take the show from their compilation (jobs of
-- compilations deleted since stay without a show and are not listed by jobs.list).
UPDATE "jobs" SET "show_id" = c."show_id"
FROM "compilations" c
WHERE "jobs"."kind" = 'compile' AND "jobs"."show_id" IS NULL
  AND c."id" = "jobs"."payload"->>'compilationId';
