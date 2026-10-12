-- Record which receipt each collapsed mirror expenditure duplicated.
--
-- Mirror collapse deletes the payer's expenditure and keeps the recipient's
-- contribution. Nothing recorded the pair, so once the expenditure was gone
-- the contribution looked free again, and the next sweep paired it with
-- another payment. `rebuildAll` repeats the sweep until nothing changes, and
-- every rebuild starts over, so one receipt could absorb any number of
-- payments. Ponte Vedra Democratic Club paid the St. Johns Democrats $100 nine
-- times in 2017; the committee booked five $100 receipts; all nine payments
-- were deleted.
--
-- `paired_hash` is the contribution's row hash, not its id, because a sweep
-- that deletes and re-files a row gives it a new id but the same hash. The
-- column ships with the rest of the tombstone in every delta, so a replica's
-- own rebuild honors the same pairs.
ALTER TABLE "transaction_tombstones" ADD COLUMN IF NOT EXISTS "paired_hash" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transaction_tombstones_paired_idx" ON "transaction_tombstones" USING btree ("paired_hash") WHERE "paired_hash" IS NOT NULL;
