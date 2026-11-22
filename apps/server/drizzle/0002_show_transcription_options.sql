ALTER TABLE "shows" ADD COLUMN "smart_format" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "shows" ADD COLUMN "key_terms" text[] DEFAULT '{}'::text[] NOT NULL;