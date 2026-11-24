ALTER TABLE "changes" ALTER COLUMN "show_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ALTER COLUMN "show_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "changes" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "changes_team" ON "changes" USING btree ("team_id","at") WHERE team_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_team_title" ON "wiki_pages" USING btree ("team_id","title_norm") WHERE deleted_at is null and team_id is not null;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_scope" CHECK (show_id is not null or team_id is not null);--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_layer" CHECK ((show_id is null) <> (team_id is null));