-- Divide the two Florida Forward accounts by date.
--
-- Two committees carry the name "Florida Forward". Account 56217 is a closed
-- CCE in Trinity, chaired by Richard Corcoran with Abby Dupree as treasurer.
-- Account 83794 is an active PAC in Gainesville, chaired by William S. Jones,
-- who is also its treasurer. They are not one operation and they do not merge.
--
-- Both nodes carry the normalized name FLORIDA FORWARD, and the resolver's
-- exact-match step reads `WHERE normalized_name = $1 LIMIT 1` with no ORDER BY.
-- Which node that returns is not determined, so the same committee's rows went
-- to one node in one ingest run and the other node in the next. 53 expenditures
-- landed on 56217 and 48 on 83794, by nothing but the order of a query plan.
--
-- That split also hid 33 duplicate payments from the mirror rule. Each pair is
-- one transfer filed from both ends: the payer's expenditure on one node and
-- the recipient's contribution on the other. Every one of the 33 has exactly
-- that shape, and none is two expenditures, which is what two committees each
-- making their own payment would file. The mirror rule could not see them
-- because it only pairs rows already sitting between the same two nodes.
--
-- The rule here is the date. 2020-10-13 is the first date on 83794. Everything
-- from that day onward is 83794's. Everything before it is 56217's. That puts
-- both halves of every duplicate pair on one node, and the mirror pass in the
-- rebuild then deletes the duplicates without being told about them.
--
-- 8 rows move to or stay on 56217 ($6,929, all 2018). 225 go to 83794.
--
-- Run on the Mac only. Follow with `pnpm ingest rebuild`. Safe to run twice.
BEGIN;

UPDATE transactions SET from_entity_id = '7b2481c6-c6e7-4b6b-a6e7-22b1a102a8e9'
 WHERE from_entity_id = 'fac2fa8e-e908-49e1-b9b2-900b34c772fe' AND txn_date >= DATE '2020-10-13';

UPDATE transactions SET to_entity_id = '7b2481c6-c6e7-4b6b-a6e7-22b1a102a8e9'
 WHERE to_entity_id = 'fac2fa8e-e908-49e1-b9b2-900b34c772fe' AND txn_date >= DATE '2020-10-13';

UPDATE transactions SET from_entity_id = 'fac2fa8e-e908-49e1-b9b2-900b34c772fe'
 WHERE from_entity_id = '7b2481c6-c6e7-4b6b-a6e7-22b1a102a8e9' AND txn_date < DATE '2020-10-13';

UPDATE transactions SET to_entity_id = 'fac2fa8e-e908-49e1-b9b2-900b34c772fe'
 WHERE to_entity_id = '7b2481c6-c6e7-4b6b-a6e7-22b1a102a8e9' AND txn_date < DATE '2020-10-13';

COMMIT;
