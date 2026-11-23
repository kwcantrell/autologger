-- Custom SQL migration file, put your code below! --
-- Events stored before their session's start timecode by versions before #229 (negative atSec,
-- sometimes negative frames after a frame-rate change): clamp them to the start (atSec 0) so
-- events.list stops returning negative atSec and sessions.update accepts clock changes again.
-- Only timecode_frames changes; nothing is recorded in the change log. Idempotent: clamped rows
-- no longer match. Events without a timecode are left alone.
UPDATE "events" SET "timecode_frames" = s."start_offset_frames"
FROM "sessions" s
WHERE s."id" = "events"."session_id" AND "events"."timecode_frames" < s."start_offset_frames";
