-- Give the 2026-09-17 county sweeps the cycle they were filed under.
--
-- `ingest county <slug>` with no `--election` swept whatever cycle the portal
-- opens on, which is right, and then stamped nothing, which is not: the code
-- only derived a cycle when an election id was passed by hand. 326 rows landed
-- with `election_cycle` null — 109 in St. Johns, which had no such row before,
-- and 217 in Duval. Every figure filtered by cycle missed all of them.
--
-- Both portals open on the 2026 cycle: St. Johns offers "2026 Election Cycle
-- (11/3/2026)" as option 20 and Duval "2026 General Election (11/3/2026)" as
-- option 40, each marked `selected`. That is 20261103-GEN in cycles.ts.
--
-- Scoped to the two feeds, to the null rows, and to the day they arrived, so
-- it cannot reach Duval's 95,504 older null rows. Those come from all-cycle
-- sweeps whose cycle is not knowable from the row alone and are a separate
-- question.
--
-- Written as an UPDATE so the trigger stamps updated_at and the rows travel in
-- the next delta. The parser now reads the `selected` option, so a later sweep
-- needs none of this. Run on the Mac only. Safe to run twice.
UPDATE transactions t
   SET election_cycle = '20261103-GEN'
  FROM sources s
 WHERE s.id = t.source_id
   AND s.key IN ('voterfocus-stjohns', 'voterfocus-duval')
   AND t.election_cycle IS NULL
   AND t.ingested_at >= '2026-09-17'
   AND t.ingested_at < '2026-09-18';
