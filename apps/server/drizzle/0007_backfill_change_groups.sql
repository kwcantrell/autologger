-- Custom SQL migration file, put your code below! --
-- Backfill group ids for changes recorded before change groups (0006). Until then every change
-- one op call wrote got `at` = the transaction's now(), so rows sharing op, actor, token and the
-- exact `at` came from one call: give each such set the same deterministic id. Rows recorded since
-- 0006 already have a group id (and use clock_timestamp()), so only null rows are touched.
UPDATE "changes"
SET "group_id" = 'grp_' || substr(md5(
  "op" || '|' || coalesce("actor_id", '') || '|' || coalesce("token_id", '') || '|' ||
  ("at" AT TIME ZONE 'UTC')::text
), 1, 14)
WHERE "group_id" IS NULL;
