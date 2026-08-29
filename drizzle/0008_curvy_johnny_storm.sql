CREATE TABLE "entity_tombstones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merged_into" uuid,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
-- Reassignments that already happened, before there was a column to record
-- them in. A transaction attached to an entity that did not exist when the
-- transaction was loaded can only have got there by being moved, so its
-- attribution changed no earlier than that entity was created. Runs before the
-- trigger exists, or the trigger would stamp all of them with now().
UPDATE "transactions" t
   SET "updated_at" = e."created_at"
  FROM "entities" e
 WHERE (e."id" = t."from_entity_id" OR e."id" = t."to_entity_id")
   AND e."created_at" > t."ingested_at";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "touch_updated_at"() RETURNS trigger AS $$
BEGIN
  NEW."updated_at" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "transactions_touch_updated_at" ON "transactions";--> statement-breakpoint
-- A trigger rather than application code: the corrections this exists to catch
-- are typically hand-written UPDATE statements, which no application code sees.
CREATE TRIGGER "transactions_touch_updated_at"
BEFORE UPDATE ON "transactions"
FOR EACH ROW EXECUTE FUNCTION "touch_updated_at"();--> statement-breakpoint
-- Partial: all but a few hundred of three million rows are null, and only the
-- non-null ones are ever selected on.
CREATE INDEX "transactions_updated_at_idx" ON "transactions" ("updated_at")
  WHERE "updated_at" IS NOT NULL;
