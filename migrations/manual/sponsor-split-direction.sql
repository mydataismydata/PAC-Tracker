-- Point each sponsor row the way it was filed.
--
-- Two faults are left over from the sponsor splits of 2026-09-16, and both
-- come from the same place. `split-rows` records the as-filed spelling of each
-- row it moves, and for a self-loop it reads that spelling off the payer side
-- only. Where the organization was the payee, the spelling it recorded is the
-- committee's, not the organization's.
--
-- The first fault is an alias: three organizations carry their committee's
-- spelling as a manual alias, which would route the committee's own filings to
-- the organization on the next ingest.
--
-- The second is direction. unfold-sponsor-selfloops.sql used those aliases to
-- decide which endpoint belonged to the organization, so on the same three
-- pairs it kept the wrong one and the edge came out reversed.
--
-- Both are settled by the filed names rather than by the aliases. A row's
-- payer is whichever entity its raw_from_name spells, and its payee is
-- whichever entity its raw_to_name spells. That is true of every row on these
-- pairs, so this statement sets all of them and not only the reversed ones.
BEGIN;

CREATE TEMP TABLE _pairs(org uuid, committee uuid) ON COMMIT DROP;
INSERT INTO _pairs VALUES
  ('62badf82-da85-4c82-95e8-1dd56b907c0f','627543a2-f24d-48b9-8eb4-0a3d63074bdd'),
  ('d247066e-f27a-4bc1-add7-f1a850d9efc0','c9c15007-341d-4dd9-a9b2-a8e30fcdda44'),
  ('6662b4ba-096f-482a-a727-c3a83efcc7c0','3dff3933-830f-4c3a-bfe7-335e81a7b4ff'),
  ('c79f1e12-d092-4557-a7d0-9a387184eeab','f3864d9e-9561-4aab-8f17-81be70d4bc70'),
  ('8baa01a7-99e3-47c5-a972-4ff3113f2b92','cf36ef24-a3c1-41d3-8586-7422ceaa3d35'),
  ('0262268b-2809-41de-9a7b-8c5f323ff595','2e1c121c-f75f-4f7c-a388-6838f46b2630'),
  ('e8727fa3-95cb-42e9-954c-fb9dc6a67db5','e39367ae-68c2-4d47-92c4-f9d9108c892d'),
  ('9852f6c1-84f0-4e6d-b8f9-3986f58beade','9e675807-b26e-41c5-a9c0-d8f07fef3a83'),
  ('62994083-d310-4c13-b76a-7e023bce1ef2','7fe07994-b212-4d46-ad7f-bd2d06784fa3'),
  ('1560a7be-4f41-4e15-b665-6624421cda56','33562b40-8818-4965-ba12-4667471dae1b'),
  ('1b87daa4-52ec-40d5-b293-88b384d18bd9','ae0a2813-7697-4f93-8238-2083af36baff'),
  ('4267c9dd-5f47-4165-adfc-2eb920456a1f','d22d2b66-c72e-4571-afcb-4989f3470597'),
  ('26839791-d671-4339-b253-75a1305f63ed','d22d2b66-c72e-4571-afcb-4989f3470597'),
  ('66070974-f41f-4f6d-9514-8d48d1deaee0','8fd7dedf-1ef5-4bf9-b5ee-8add13c53e88'),
  ('5684bf39-874f-4234-b5e4-f59e5c785288','b52ad49e-2379-4abb-8c7f-527ea6da3399'),
  ('aeee17de-55ba-4bb9-aa3e-be0c306a9a19','9f18e656-30f9-49e1-93c9-d0082a08fdda'),
  ('f19d0165-86e2-4a17-8c54-4246c9ed166b','6e90341d-aec6-49fe-a39b-51f909c450e0'),
  ('cc713682-5948-44ea-a853-586f9256befa','2bfca345-dc9b-4d3e-b6c3-048b9581b991'),
  ('82ac7958-4eb0-48b0-b992-c3d7dd3f1ce7','ee461f04-3280-4b8e-9047-2e2592db48c6');

-- normalizeName in SQL: drop a trailing type tag, fold & to AND, keep
-- alphanumerics and single spaces.
CREATE OR REPLACE FUNCTION pg_temp.fold(t text) RETURNS text AS $$
  SELECT trim(regexp_replace(regexp_replace(
           replace(upper(regexp_replace(t, '\s*\([A-Za-z]{2,3}\)\s*$', '')), '&', ' AND '),
           '[^A-Z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g'));
$$ LANGUAGE sql IMMUTABLE;

-- An organization never keeps a spelling that names its committee.
DELETE FROM entity_aliases a
 USING _pairs p, entities c
 WHERE a.entity_id = p.org AND c.id = p.committee
   AND a.normalized_alias = c.normalized_name
   AND a.origin = 'manual';

UPDATE transactions t
   SET from_entity_id = CASE WHEN pg_temp.fold(t.raw_from_name) = c.normalized_name
                             THEN p.committee ELSE p.org END,
       to_entity_id   = CASE WHEN pg_temp.fold(t.raw_to_name)   = c.normalized_name
                             THEN p.committee ELSE p.org END
  FROM _pairs p, entities c
 WHERE c.id = p.committee
   AND ((t.from_entity_id = p.org AND t.to_entity_id = p.committee)
     OR (t.from_entity_id = p.committee AND t.to_entity_id = p.org)
     OR (t.from_entity_id = p.org AND t.to_entity_id = p.org));

-- The state feed cuts a committee name at 40 characters and appends its type
-- tag, so the committee's spelling on these rows is a truncation and never
-- equals its stored name. The tag is what identifies it: the feed writes one
-- for a committee and none for the organization that pays it. Rows still
-- looping after the statement above are settled that way, and only where
-- exactly one of the two spellings carries a tag.
UPDATE transactions t
   SET from_entity_id = CASE WHEN t.raw_from_name ~ '\([A-Za-z]{2,3}\)\s*$'
                             THEN p.committee ELSE p.org END,
       to_entity_id   = CASE WHEN t.raw_to_name ~ '\([A-Za-z]{2,3}\)\s*$'
                             THEN p.committee ELSE p.org END
  FROM _pairs p
 WHERE t.from_entity_id = p.org AND t.to_entity_id = p.org
   AND (t.raw_from_name ~ '\([A-Za-z]{2,3}\)\s*$') <> (t.raw_to_name ~ '\([A-Za-z]{2,3}\)\s*$');

COMMIT;
