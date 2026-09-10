-- Restamp FEC rows onto the election cycle they belong to.
--
-- The FEC loader keyed its rows `fec-2026`, copying the 8872 loader's private
-- namespace. That was wrong. An 8872 filing period is a quarter ending on an
-- arbitrary date and genuinely is not an election cycle; an FEC two-year
-- transaction period is one — the 2026 period runs January 2025 to December
-- 2026, the same election `20261103-GEN` covers.
--
-- The effect was that every federal dollar sat outside the cycle filter.
-- Randy Fine for Congress showed $0 received for 2026 against $2,768,554 with
-- no filter, because the only row the filter could see was a $5,000 payment
-- that came from a Florida county feed.
--
-- Written as an UPDATE rather than a purge and reload on purpose: an update
-- fires the `transactions_touch_updated_at` trigger, so the corrected rows
-- travel in the next delta. Deleting and re-inserting would give them new ids
-- against a far side that is unique on the row hash, and the load would fail.
--
-- Run on the Mac. The VPS receives the result through the normal delta; it
-- does not need this file. Safe to run twice.
BEGIN;

UPDATE transactions SET election_cycle = '20261103-GEN'
 WHERE election_cycle = 'fec-2026';

UPDATE transactions SET election_cycle = '20241105-GEN'
 WHERE election_cycle = 'fec-2024';

SELECT election_cycle, count(*) AS rows
  FROM transactions
 WHERE election_cycle LIKE 'fec-%'
 GROUP BY 1;

COMMIT;
