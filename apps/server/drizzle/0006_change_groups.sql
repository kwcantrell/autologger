ALTER TABLE "changes" ADD COLUMN "group_id" text;--> statement-breakpoint
CREATE INDEX "changes_group" ON "changes" USING btree ("group_id");