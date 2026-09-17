-- Put the second endpoint of a sponsor's self-loop back on the committee.
--
-- The corrections of 2026-09-16 gave nineteen sponsoring organizations an
-- entity of their own, away from the committee each one funds. `split-rows`
-- repointed every row that carried the organization's spelling, and for rows
-- with the organization on one side only that is exactly right.
--
-- A self-loop has it on both sides. The UPDATE inside split-rows moves
-- from_entity_id and to_entity_id together, so those 371 rows did not divide:
-- they moved whole, and the loop reappeared on the new entity. The split has
-- to keep one endpoint and give back the other.
--
-- Which endpoint stays is already recorded. `split-rows` wrote the as-filed
-- spelling of every row it moved into entity_aliases on the target, so the
-- side whose raw name matches one of those aliases is the organization's side.
-- The other side is the committee's, and goes back to it.
BEGIN;

CREATE TEMP TABLE _pairs(org uuid, committee uuid) ON COMMIT DROP;
INSERT INTO _pairs VALUES
  ('62badf82-da85-4c82-95e8-1dd56b907c0f','627543a2-f24d-48b9-8eb4-0a3d63074bdd'), -- Americans for Prosperity Action
  ('d247066e-f27a-4bc1-add7-f1a850d9efc0','c9c15007-341d-4dd9-a9b2-a8e30fcdda44'), -- Americans for Prosperity, Inc.
  ('6662b4ba-096f-482a-a727-c3a83efcc7c0','3dff3933-830f-4c3a-bfe7-335e81a7b4ff'), -- Florida Justice Association
  ('c79f1e12-d092-4557-a7d0-9a387184eeab','f3864d9e-9561-4aab-8f17-81be70d4bc70'), -- Central Florida Hotel and Lodging
  ('8baa01a7-99e3-47c5-a972-4ff3113f2b92','cf36ef24-a3c1-41d3-8586-7422ceaa3d35'), -- The Southern Group of Florida
  ('0262268b-2809-41de-9a7b-8c5f323ff595','2e1c121c-f75f-4f7c-a388-6838f46b2630'), -- Protect Democracy
  ('e8727fa3-95cb-42e9-954c-fb9dc6a67db5','e39367ae-68c2-4d47-92c4-f9d9108c892d'), -- People for Progress
  ('9852f6c1-84f0-4e6d-b8f9-3986f58beade','9e675807-b26e-41c5-a9c0-d8f07fef3a83'), -- Florida Restaurant and Lodging
  ('62994083-d310-4c13-b76a-7e023bce1ef2','7fe07994-b212-4d46-ad7f-bd2d06784fa3'), -- American Police Officers Alliance
  ('1560a7be-4f41-4e15-b665-6624421cda56','33562b40-8818-4965-ba12-4667471dae1b'), -- Florida Independent Concrete
  ('1b87daa4-52ec-40d5-b293-88b384d18bd9','ae0a2813-7697-4f93-8238-2083af36baff'), -- Florida Nursery, Growers and Landscape
  ('4267c9dd-5f47-4165-adfc-2eb920456a1f','d22d2b66-c72e-4571-afcb-4989f3470597'), -- UTD TIGER COPE North
  ('26839791-d671-4339-b253-75a1305f63ed','d22d2b66-c72e-4571-afcb-4989f3470597'), -- UTD TIGER COPE South
  ('66070974-f41f-4f6d-9514-8d48d1deaee0','8fd7dedf-1ef5-4bf9-b5ee-8add13c53e88'), -- American Gun Coalition
  ('5684bf39-874f-4234-b5e4-f59e5c785288','b52ad49e-2379-4abb-8c7f-527ea6da3399'), -- Seminole County Professional Firefighters
  ('aeee17de-55ba-4bb9-aa3e-be0c306a9a19','9f18e656-30f9-49e1-93c9-d0082a08fdda'), -- Florida Chiropractic Physician Association
  ('f19d0165-86e2-4a17-8c54-4246c9ed166b','6e90341d-aec6-49fe-a39b-51f909c450e0'), -- South Florida Veterinary Medical Association
  ('cc713682-5948-44ea-a853-586f9256befa','2bfca345-dc9b-4d3e-b6c3-048b9581b991'), -- Vote Blue Network of Florida
  ('82ac7958-4eb0-48b0-b992-c3d7dd3f1ce7','ee461f04-3280-4b8e-9047-2e2592db48c6'); -- Grow Tallahassee

UPDATE transactions t
   SET to_entity_id = p.committee
  FROM _pairs p
 WHERE t.from_entity_id = p.org AND t.to_entity_id = p.org
   AND EXISTS (SELECT 1 FROM entity_aliases a
                WHERE a.entity_id = p.org AND upper(a.alias) = upper(t.raw_from_name));

UPDATE transactions t
   SET from_entity_id = p.committee
  FROM _pairs p
 WHERE t.from_entity_id = p.org AND t.to_entity_id = p.org
   AND EXISTS (SELECT 1 FROM entity_aliases a
                WHERE a.entity_id = p.org AND upper(a.alias) = upper(t.raw_to_name));

-- Two spellings that fold to one alias key leave only the first as a literal,
-- so an exact match on entity_aliases.alias misses the other. These last
-- statements compare the folded forms instead, the way normalizeName does.
UPDATE transactions t
   SET to_entity_id = p.committee
  FROM _pairs p
 WHERE t.from_entity_id = p.org AND t.to_entity_id = p.org
   AND EXISTS (SELECT 1 FROM entity_aliases a
                WHERE a.entity_id = p.org
                  AND a.normalized_alias = regexp_replace(regexp_replace(
                        replace(upper(t.raw_from_name), '&', ' AND '),
                        '[^A-Z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g'));

UPDATE transactions t
   SET from_entity_id = p.committee
  FROM _pairs p
 WHERE t.from_entity_id = p.org AND t.to_entity_id = p.org
   AND EXISTS (SELECT 1 FROM entity_aliases a
                WHERE a.entity_id = p.org
                  AND a.normalized_alias = regexp_replace(regexp_replace(
                        replace(upper(t.raw_to_name), '&', ' AND '),
                        '[^A-Z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g'));

COMMIT;
