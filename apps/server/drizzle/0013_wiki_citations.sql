CREATE TABLE "wiki_citations" (
	"from_page_id" text NOT NULL,
	"ord" integer NOT NULL,
	"session_id" text NOT NULL,
	"start_sec" double precision NOT NULL,
	"end_sec" double precision,
	"label" text NOT NULL,
	CONSTRAINT "wiki_citations_from_page_id_ord_pk" PRIMARY KEY("from_page_id","ord")
);
--> statement-breakpoint
ALTER TABLE "wiki_citations" ADD CONSTRAINT "wiki_citations_from_page_id_wiki_pages_id_fk" FOREIGN KEY ("from_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_citations_session" ON "wiki_citations" USING btree ("session_id");