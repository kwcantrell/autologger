CREATE TABLE "compilations" (
	"id" text PRIMARY KEY NOT NULL,
	"show_id" text NOT NULL,
	"title" text NOT NULL,
	"clips" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" text,
	"error" text,
	"object_key" text,
	"duration_sec" double precision NOT NULL,
	"size_bytes" bigint,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compilations" ADD CONSTRAINT "compilations_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compilations" ADD CONSTRAINT "compilations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compilations_show" ON "compilations" USING btree ("show_id","created_at");