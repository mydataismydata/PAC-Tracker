-- Officeholders' Statements of Solicitation, as the Division of Elections
-- publishes them.
--
-- A legislator's own committee rarely carries their name, and its registration
-- rarely names them. The statement they file under s. 106.0701 is what ties
-- the two together, so a person's page can list the committees they raise for.
--
-- Only the new table. drizzle-kit also offered `transaction_tombstones`, which
-- 0012 and 0013 created by hand without updating its snapshot; this
-- migration's snapshot now carries it, so the next generate will not repeat it.
CREATE TABLE IF NOT EXISTS "solicitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid,
	"solicitor_name" text NOT NULL,
	"solicitor_last" text NOT NULL,
	"solicitor_first" text NOT NULL,
	"office" text,
	"form_type" text NOT NULL,
	"received" date,
	"org_name" text NOT NULL,
	"org_normalized" text NOT NULL,
	"entity_id" uuid,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "solicitations" ADD CONSTRAINT "solicitations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solicitations" ADD CONSTRAINT "solicitations_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "solicitations_filing_key" ON "solicitations" USING btree ("solicitor_name","org_name","form_type","received");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "solicitations_last_idx" ON "solicitations" USING btree ("solicitor_last");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "solicitations_entity_idx" ON "solicitations" USING btree ("entity_id");
