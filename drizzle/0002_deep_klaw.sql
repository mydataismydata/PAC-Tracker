CREATE TABLE "entity_cycle_totals" (
	"entity_id" uuid NOT NULL,
	"election_cycle" text NOT NULL,
	"total_received" numeric(16, 2) DEFAULT '0' NOT NULL,
	"total_given" numeric(16, 2) DEFAULT '0' NOT NULL,
	"in_degree" integer DEFAULT 0 NOT NULL,
	"out_degree" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "entity_cycle_totals_entity_id_election_cycle_pk" PRIMARY KEY("entity_id","election_cycle")
);
--> statement-breakpoint
DROP INDEX "edge_rollups_pair_key";--> statement-breakpoint
DROP INDEX "edge_rollups_to_amount_idx";--> statement-breakpoint
DROP INDEX "edge_rollups_from_amount_idx";--> statement-breakpoint
--> edge_rollups is derived entirely from transactions, so it is cheaper and
--> safer to empty it than to backfill a NOT NULL column across ~930k rows.
--> `pnpm ingest rebuild` repopulates it, now split per cycle.
TRUNCATE "edge_rollups";--> statement-breakpoint
ALTER TABLE "edge_rollups" ADD COLUMN "election_cycle" text NOT NULL;--> statement-breakpoint
ALTER TABLE "entity_cycle_totals" ADD CONSTRAINT "entity_cycle_totals_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_cycle_totals_cycle_idx" ON "entity_cycle_totals" USING btree ("election_cycle");--> statement-breakpoint
CREATE UNIQUE INDEX "edge_rollups_pair_key" ON "edge_rollups" USING btree ("from_entity_id","to_entity_id","election_cycle");--> statement-breakpoint
CREATE INDEX "edge_rollups_to_amount_idx" ON "edge_rollups" USING btree ("to_entity_id","election_cycle","total_amount");--> statement-breakpoint
CREATE INDEX "edge_rollups_from_amount_idx" ON "edge_rollups" USING btree ("from_entity_id","election_cycle","total_amount");