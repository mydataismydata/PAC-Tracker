-- Interest income and treasury parking are not political money, and this graph
-- is only for real PAC and candidate money (2026-09-05). Three sets go:
--
--   1. Interest paid by banks and brokerages to committees: Florida's INT
--      type, its county-feed truncation IN, and a few penny rows filed under
--      other codes whose purpose simply reads "interest" / "bank interest".
--      5,944 INT rows were $16.6M; they made banks read as "original sources".
--   2. "Transfer to interest bearing account" expenditures: a committee moving
--      its own money into a savings vehicle. A bank deposit is never filed at
--      all, so these were the odd ones out (CFR's eight, Florida Justice PAC's
--      three to itself).
--   3. Every row on CHRISTIAN FINANCIAL RESOURCES, a 501(c)(3) church loan
--      fund the Jones committees used as an interest-bearing account. Its 36
--      "contributions" to them were their own principal coming back, filed as
--      checks, which made a church fund the trace's $1.1M original source.
--
-- The same rules now run at ingest (pipeline.ts, ingestTransactionRows), so a
-- re-sweep does not bring any of it back. Run on every database, then rebuild.

DELETE FROM transactions
 WHERE direction = 'contribution'
   AND (upper(txn_type_code) IN ('INT', 'IN')
        OR inkind_description ~* '^\s*(bank\s+|savings\s+)?interest\M');

DELETE FROM transactions
 WHERE direction = 'expenditure'
   AND inkind_description ~* 'INTEREST[ -]BEARING';

DELETE FROM transactions
 WHERE from_entity_id = '6f77c137-fede-436f-b440-e3ebe50bb005'
    OR to_entity_id   = '6f77c137-fede-436f-b440-e3ebe50bb005';
