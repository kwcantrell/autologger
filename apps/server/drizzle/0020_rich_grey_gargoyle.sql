CREATE TABLE "team_youtube_cookies" (
	"team_id" text PRIMARY KEY NOT NULL,
	"cookies" text NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "team_youtube_cookies" ADD CONSTRAINT "team_youtube_cookies_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_youtube_cookies" ADD CONSTRAINT "team_youtube_cookies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;