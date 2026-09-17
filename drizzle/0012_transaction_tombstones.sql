-- Record a deleted transaction, so the sync can carry the deletion.
--
-- A delta carries inserts, updates and entity tombstones. A deleted row left
-- nothing behind to carry, so every row this machine deleted after having
-- shipped it stayed on the deployment box for good, and the box could not
-- repair it in its own rebuild: mirror collapse only pairs rows that already
-- sit between the same two nodes, and a row the correction never reached still
-- points at the old one. That had reached 2,743 rows and $2.6M on 286 private
-- individuals by 2026-09-17.
--
-- The trigger is per statement with a transition table, not per row. Mirror
-- collapse deletes thousands of rows in one statement and a per-row trigger
-- would charge for each of them.
--
-- `reason` is read from a session setting, so a caller that wants to say why
-- can, and one that does not is still recorded. `set_config(..., true)` makes
-- it local to the transaction.
CREATE TABLE IF NOT EXISTS "transaction_tombstones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_row_hash" text NOT NULL,
	"source_id" uuid,
	"reason" text,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transaction_tombstones" ADD CONSTRAINT "transaction_tombstones_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transaction_tombstones_hash_idx" ON "transaction_tombstones" USING btree ("source_row_hash");--> statement-breakpoint

CREATE OR REPLACE FUNCTION "record_transaction_tombstones"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO transaction_tombstones (id, source_row_hash, source_id, reason)
  SELECT r.id, r.source_row_hash, r.source_id,
         nullif(current_setting('pactracker.delete_reason', true), '')
    FROM removed r
  ON CONFLICT (id) DO NOTHING;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "transactions_record_tombstone" ON "transactions";--> statement-breakpoint
CREATE TRIGGER "transactions_record_tombstone"
AFTER DELETE ON "transactions"
REFERENCING OLD TABLE AS "removed"
FOR EACH STATEMENT EXECUTE FUNCTION "record_transaction_tombstones"();
