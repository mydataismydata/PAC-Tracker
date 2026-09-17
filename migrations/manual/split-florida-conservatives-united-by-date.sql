-- Divide the two Florida Conservatives United accounts by date.
--
-- The same shape as Florida Forward, and the same test settles it. Account
-- 64266 is a closed PAC in Gainesville chaired by Robert Rush, who is also its
-- treasurer. Account 68041 is a closed PAC in Tallahassee chaired by William S.
-- Jones, who is also its treasurer. Different people in both roles, so these
-- are two committees and they do not merge.
--
-- Both nodes carry the normalized name FLORIDA CONSERVATIVES UNITED, and the
-- resolver's exact-match step reads `WHERE normalized_name = $1 LIMIT 1` with
-- no ORDER BY, so their rows were dealt between the nodes by a query plan.
--
-- That split hid 24 duplicate payments worth $1,398,970 from the mirror rule.
-- Each one is a single transfer filed from both ends: the payer's expenditure
-- landed on 64266 and the recipient's contribution on 68041. Not one of the 24
-- is two expenditures, which is what two committees each making their own
-- payment would file. The mirror rule could not pair them because it only looks
-- at rows already sitting between the same two nodes.
--
-- 2019-02-04 is the first date on 68041. Everything from that day onward is
-- 68041's and everything before it is 64266's. That puts both halves of every
-- duplicate on one node, and the rebuild's mirror pass then deletes them
-- without being told they exist.
--
-- Run on the Mac only. Follow with `pnpm ingest rebuild`. Safe to run twice.
BEGIN;

UPDATE transactions SET from_entity_id = 'f7782425-5d13-4382-9dc6-216e4f666b23'
 WHERE from_entity_id = 'de153afe-1671-4821-982e-1a2c0ad1e343' AND txn_date >= DATE '2019-02-04';

UPDATE transactions SET to_entity_id = 'f7782425-5d13-4382-9dc6-216e4f666b23'
 WHERE to_entity_id = 'de153afe-1671-4821-982e-1a2c0ad1e343' AND txn_date >= DATE '2019-02-04';

UPDATE transactions SET from_entity_id = 'de153afe-1671-4821-982e-1a2c0ad1e343'
 WHERE from_entity_id = 'f7782425-5d13-4382-9dc6-216e4f666b23' AND txn_date < DATE '2019-02-04';

UPDATE transactions SET to_entity_id = 'de153afe-1671-4821-982e-1a2c0ad1e343'
 WHERE to_entity_id = 'f7782425-5d13-4382-9dc6-216e4f666b23' AND txn_date < DATE '2019-02-04';

COMMIT;
