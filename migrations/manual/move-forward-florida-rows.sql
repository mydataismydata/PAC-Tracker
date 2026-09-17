-- Put Forward Florida's 6,140 rows back on Forward Florida.
--
-- Two committees: Florida Forward, account 83794, Gainesville, and Forward
-- Florida, account 65255, Fort Lauderdale. The names are the same two words in
-- opposite order, which trigram scoring rates 0.935 — over the 0.88 gate — so
-- the resolver wrote "Forward Florida" as an alias of Florida Forward and sent
-- every row filed under that name to the wrong node.
--
-- It sent 6,140 of them, worth $764,711: 6,104 where Forward Florida received
-- the money and 36 where it paid. Node 83794 held 6,302 rows and 97% of them
-- belonged to a committee it has nothing to do with. Forward Florida's own node
-- held nothing at all.
--
-- Matched on the name as filed, not on the alias, because the alias is the
-- thing that was wrong. Every row that says Forward Florida moves; every row
-- that says Florida Forward stays. The two accounts share no transaction and
-- no row has 83794 on both sides, so nothing here can make a self-loop.
--
-- The aliases go too. Leaving them keeps a lookup path from the wrong name to
-- the wrong node, and FORWARD FLORIDA ACTION INC is a third organisation again.
-- The exact-name match now answers for Forward Florida, because its own node
-- carries that normalized name and exact match runs before alias lookup.
--
-- Run on the Mac only; the rows travel in the next delta. Follow with
-- `pnpm ingest rebuild`. Safe to run twice.
BEGIN;

UPDATE transactions
   SET to_entity_id = '10a5c709-1999-48de-8044-aa600596d5f4'
 WHERE to_entity_id = '7b2481c6-c6e7-4b6b-a6e7-22b1a102a8e9'
   AND upper(replace(raw_to_name, ' ', '')) LIKE 'FORWARDFLORIDA%';

UPDATE transactions
   SET from_entity_id = '10a5c709-1999-48de-8044-aa600596d5f4'
 WHERE from_entity_id = '7b2481c6-c6e7-4b6b-a6e7-22b1a102a8e9'
   AND upper(replace(raw_from_name, ' ', '')) LIKE 'FORWARDFLORIDA%';

DELETE FROM entity_aliases
 WHERE entity_id = '7b2481c6-c6e7-4b6b-a6e7-22b1a102a8e9'
   AND replace(normalized_alias, ' ', '') LIKE 'FORWARDFLORIDA%';

COMMIT;
