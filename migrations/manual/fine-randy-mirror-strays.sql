-- Remove 29 stray Randy Fine rows the VPS could not learn about.
--
-- Two corrections moved 37 PAC contributions off the person "FINE RANDY" and
-- onto his state senate campaign, where 29 of them turned out to be the PACs'
-- own filings of money the candidate had already reported. The rebuild's
-- mirror rule deleted those 29 as duplicates and kept the 8 that were new.
--
-- The Mac is therefore correct and the VPS is not. A delta carries inserts,
-- updates and entity tombstones; a transaction deleted by the mirror rule
-- leaves nothing behind to carry, so these rows never moved and never died
-- over there. They still point at the man, and they still double-count
-- $28,500 that his campaign account already reports.
--
-- The VPS cannot fix this in its own rebuild: mirror collapse only pairs rows
-- that already sit between the same two nodes, and over there these are still
-- attached to an individual.
--
-- Keyed on the source row hash, which is stable across both databases, and
-- guarded on the entity so it can never reach a row that has since been
-- reattributed. Safe to run twice.
BEGIN;

CREATE TEMP TABLE _stray_hashes (h text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _stray_hashes (h) VALUES
  ('bad58e2355e81a2a8381854b764279f6'),
  ('178abd10495b9f308556299f56248b8f'),
  ('beb1b47aa2cba2e8d03d89988bc3bfef'),
  ('89d9abbe01ea32996e8bd5036b3b62bb'),
  ('7ece6d5695b71878af95fc8ff770239b'),
  ('6563d376218f3b698427c3740d4e3edf'),
  ('c20296121c4a86bc98add7a694949aaf'),
  ('c08ec9ab919a6148dfac297bbdf2bbac'),
  ('183c552d7f905ad1ec67a6c71304b244'),
  ('95cd772cfd0e9faf92b11ea65e787723'),
  ('7c383d685f1ac697ff5052167ddb6519'),
  ('bb5144bd9071ea1ffd72bdc50c74abbd'),
  ('b342c2dcd7f9f14bb76e3067e751131a'),
  ('80a642ea5483e45c3b095b5d87e9fbe7'),
  ('75426cac6cf0e1a65fe8cf86175d5cd3'),
  ('b155814c0eb3c1ce5cf7b5288b29d34a'),
  ('b70d6787002328f3bf610f5c4e2496bb'),
  ('b81aff8552052088651a587e89f52af8'),
  ('04536b77347d6390c11d4ca471d6c7b9'),
  ('94ad14b1f934b6fb5905cf959ecfd3e1'),
  ('4127e8ceb6ea26e5c97622cf78db749a'),
  ('d9adc06ba75fe3673ef4f3bb184f4c58'),
  ('ae9d919fb4e98b624978673bfdaf6e78'),
  ('f876344b4ec03725942273eaf2a22d26'),
  ('c11ab46f455b7872b2252a2dab864323'),
  ('7b6540b6b81933582eb1566b7086d634'),
  ('a3ba56e6d8ad013b50b8a0652245d194'),
  ('6e28375e4bc23f4565a4dc1a849d6a26'),
  ('a022e88675c9666e739da270070bf79c');

SELECT count(*) AS "rows that will go"
  FROM transactions t
  JOIN entities e ON e.id = t.to_entity_id
  JOIN _stray_hashes s ON s.h = t.source_row_hash
 WHERE e.normalized_name = 'FINE RANDY';

DELETE FROM transactions t
 USING entities e, _stray_hashes s
 WHERE e.id = t.to_entity_id
   AND s.h = t.source_row_hash
   AND e.normalized_name = 'FINE RANDY';

COMMIT;
