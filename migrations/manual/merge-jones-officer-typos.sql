-- Fold two misspellings of one treasurer into his real key.
--
-- The state's committee list spells the same person three ways. `officerKey`
-- already folds middle names and punctuation away, so "William Jones",
-- "William S Jones" and "William S. Jones" all key as JONES WILLIAM. It cannot
-- cross a misspelt surname or forename, so these two split off:
--
--   JONES WILLIAMS  <- "Williams S Jones", "Williams S. Jones"
--   JONES WILIAM    <- "Wiliam S Jones"
--
-- Seven committees hide behind them, against roughly a hundred on the correct
-- spelling. The registration link mode drew them as separate people.
--
-- `full_name` is untouched. What each committee filed is the record; only the
-- key used to match one filing against another moves.

BEGIN;

INSERT INTO officer_aliases (alias, canonical, note) VALUES
  ('JONES WILLIAMS', 'JONES WILLIAM',
   'Filed as "Williams S Jones" / "Williams S. Jones"; same Tallahassee treasurer as JONES WILLIAM.'),
  ('JONES WILIAM', 'JONES WILLIAM',
   'Filed as "Wiliam S Jones"; same person, forename misspelt in the state list.')
ON CONFLICT (alias) DO NOTHING;

-- Apply to what is already loaded. Re-ingest reaches the same result through
-- the alias lookup in ingestCommitteeRegistrations.
--
-- A committee could in principle name the person under both spellings in the
-- same role, which would collide on the partial unique index, so those rows are
-- dropped rather than updated: the correct-spelling row already says it.
DELETE FROM committee_officers dup
 USING committee_officers keep, officer_aliases a
 WHERE dup.normalized_name = a.alias
   AND keep.normalized_name = a.canonical
   AND keep.entity_id = dup.entity_id
   AND keep.role = dup.role
   AND keep.source_id IS NOT DISTINCT FROM dup.source_id
   AND keep.is_current AND dup.is_current;

UPDATE committee_officers o
   SET normalized_name = a.canonical,
       updated_at = now()
  FROM officer_aliases a
 WHERE o.normalized_name = a.alias;

COMMIT;
