CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"concurrency" integer NOT NULL,
	"kind_concurrency" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
