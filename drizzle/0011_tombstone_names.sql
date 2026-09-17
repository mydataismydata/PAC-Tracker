ALTER TABLE "entity_tombstones" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "entity_tombstones" ADD COLUMN "kind" "entity_kind";--> statement-breakpoint
ALTER TABLE "entity_tombstones" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "entity_tombstones" ADD CONSTRAINT "entity_tombstones_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;