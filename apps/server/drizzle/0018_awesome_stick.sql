CREATE TABLE "show_youtube_cookies" (
	"show_id" text PRIMARY KEY NOT NULL,
	"cookies" text NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "show_youtube_cookies" ADD CONSTRAINT "show_youtube_cookies_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_youtube_cookies" ADD CONSTRAINT "show_youtube_cookies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;