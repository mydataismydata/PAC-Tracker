-- Consolidate the St. Johns County Republican Executive Committee.
--
-- The county files under five different spellings across eras, and the bare
-- "Republican Executive Committee" -- the spelling in use since 2008 and the
-- only one used after 2016 -- resolved onto the state registry's entry for
-- GADSDEN county, 170 miles away. Gadsden's node therefore holds St. Johns'
-- and Duval's money as well as its own.
--
-- Only St. Johns is reclaimed here. Duval uses the identical bare name, so the
-- source feed is the discriminator: it is how we know which county a row came
-- from, since we chose the county when we fetched the file.

BEGIN;

\set target '''7d86b0ef-20ad-4879-b1fe-e8d3cb655265'''
\set gadsden '''64abd245-25ac-4cdb-ba8c-bed1c4d0999c'''

-- 1. Reclaim the bare-name rows that belong to St. Johns, and only those.
UPDATE transactions t SET from_entity_id = :target::uuid
  FROM sources s
 WHERE s.id = t.source_id AND s.key = 'voterfocus-stjohns'
   AND t.from_entity_id = :gadsden::uuid
   AND t.raw_from_name = 'Republican Executive Committee';

UPDATE transactions t SET to_entity_id = :target::uuid
  FROM sources s
 WHERE s.id = t.source_id AND s.key = 'voterfocus-stjohns'
   AND t.to_entity_id = :gadsden::uuid
   AND t.raw_to_name = 'Republican Executive Committee';

-- 2. Fold in the other spellings. These are wholly St. Johns, so every row
--    moves, including the two state-level rows on the 2003 record.
CREATE TEMP TABLE merged_ids (id uuid PRIMARY KEY);
INSERT INTO merged_ids VALUES
  ('ae7b2dd1-9271-4b45-afba-880724b7cf0d'),  -- St. Johns Cnty. Republican Executive Committee
  ('20b309b1-b15d-41ae-a900-534fba1757c2'),  -- ... Rep. Executive Committee Committee 2004/05
  ('51da43ed-e153-461a-b31e-82344f9f8dc8'),  -- SJC REPUBLICAN EXECUTIVE COMMI (truncated)
  ('5c17339e-3722-464e-8de5-7636428102f4');  -- SJC Republican Executive Comm.

UPDATE transactions SET from_entity_id = :target::uuid
 WHERE from_entity_id IN (SELECT id FROM merged_ids);
UPDATE transactions SET to_entity_id = :target::uuid
 WHERE to_entity_id IN (SELECT id FROM merged_ids);

-- 3. Type the survivor correctly. It was a "candidate", which is what the
--    county index implies for anything that files a report.
UPDATE entities
   SET kind = 'party', committee_type = 'PTY', is_traversable = true
 WHERE id = :target::uuid;

-- 4. Point every spelling at the survivor -- except the bare name, which
--    belongs to no county in particular and must not become a global answer.
INSERT INTO entity_aliases (entity_id, alias, normalized_alias, origin, confidence)
SELECT :target::uuid, a.alias, a.norm, 'manual', 1
  FROM (VALUES
    ('St. Johns Cnty. Republican Executive Committee', 'ST. JOHNS CNTY. REPUBLICAN EXECUTIVE COMMITTEE'),
    ('St. Johns Cnty. Rep. Executive Committee Committee 2004/05', 'ST. JOHNS CNTY. REP. EXECUTIVE COMMITTEE COMMITTEE 2004/05'),
    ('SJC REPUBLICAN EXECUTIVE COMMI', 'SJC REPUBLICAN EXECUTIVE COMMI'),
    ('SJC Republican Executive Comm.', 'SJC REPUBLICAN EXECUTIVE COMM.'),
    ('St Johns County Republican Executive Committee', 'ST JOHNS COUNTY REPUBLICAN EXECUTIVE COMMITTEE')
  ) AS a(alias, norm)
ON CONFLICT (entity_id, normalized_alias) DO NOTHING;

-- 5. Drop the alias that caused this. It was recorded at 0.809 -- below the
--    0.88 needed to link -- purely so a human could review it, then consumed
--    as an answer on every later lookup.
DELETE FROM entity_aliases
 WHERE upper(normalized_alias) = 'REPUBLICAN EXECUTIVE COMMITTEE'
   AND entity_id = :gadsden::uuid;

-- 6. Remove the now-empty fragments. Rollups and per-cycle totals reference
--    entities as well, and both are derived, so they are cleared here and
--    rebuilt from the transactions afterwards.
DELETE FROM entity_aliases WHERE entity_id IN (SELECT id FROM merged_ids);
DELETE FROM edge_rollups
 WHERE from_entity_id IN (SELECT id FROM merged_ids)
    OR to_entity_id IN (SELECT id FROM merged_ids);
DELETE FROM entity_cycle_totals WHERE entity_id IN (SELECT id FROM merged_ids);
DELETE FROM entities WHERE id IN (SELECT id FROM merged_ids);

COMMIT;
