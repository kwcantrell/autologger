CREATE TABLE "wiki_links" (
	"from_page_id" text NOT NULL,
	"target_norm" text NOT NULL,
	"target" text NOT NULL,
	"ord" integer NOT NULL,
	CONSTRAINT "wiki_links_from_page_id_target_norm_pk" PRIMARY KEY("from_page_id","target_norm")
);
--> statement-breakpoint
ALTER TABLE "wiki_links" ADD CONSTRAINT "wiki_links_from_page_id_wiki_pages_id_fk" FOREIGN KEY ("from_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_links_target" ON "wiki_links" USING btree ("target_norm");