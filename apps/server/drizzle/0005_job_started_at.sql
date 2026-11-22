ALTER TABLE "jobs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "jobs_finished" ON "jobs" USING btree ("kind","status","updated_at");