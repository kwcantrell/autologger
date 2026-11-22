DROP INDEX "wiki_pages_title";--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_title" ON "wiki_pages" USING btree ("show_id","title_norm") WHERE deleted_at is null;