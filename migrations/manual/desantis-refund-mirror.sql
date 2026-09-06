-- The $3M the Republican Party of Florida sent back, filed twice.
--
-- Empower Parents PAC and FRIENDS OF RON DESANTIS were one committee under two
-- names (state account 70275, renamed in 2023), merged in corrections.jsonl on
-- 2026-09-06. That merge puts both filings of a single refund on one node:
--
--   Empower Parents PAC -> Republican Party of Florida   -3,000,000  REF
--   Republican Party of Florida -> FRIENDS OF RON DESANTIS  +3,000,000  MON
--
-- Both describe the same money moving on 2023-02-08. Left alone they count it
-- twice in opposite directions: the node's total given falls by $3M and its
-- total received rises by $3M for one event.
--
-- `collapseMirrors` cannot see this pair. It matches a contribution against an
-- expenditure inside one from/to pair, and here both rows are expenditures
-- sitting on opposite pairs.
--
-- The payer's own negative line is the one to keep. It nets against the gross
-- gift already recorded on the same pair, which is what makes that pair's total
-- right; the other row would instead invent $3M of receipts and leave the gift
-- ungrossed-down. Matched on the row hash, which is stable across databases.
--
-- Nineteen more pairs of this shape exist elsewhere in the graph, worth
-- $122,061 between them. They are a separate cleanup, not this one.
DELETE FROM transactions
 WHERE source_row_hash = '70eb2449bf27f394509ea3c87377cfbf'
   AND amount = 3000000.00
   AND txn_date = '2023-02-08'
   AND raw_to_name = 'FRIENDS OF RON DESANTIS';
