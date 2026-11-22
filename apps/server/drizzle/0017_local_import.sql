ALTER TABLE "audio_segments" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "audio_segments" ADD COLUMN "source_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "compilations" ADD COLUMN "build_locally" boolean DEFAULT false NOT NULL;