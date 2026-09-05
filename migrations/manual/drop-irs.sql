-- Tax payments and tax refunds are not political money (2026-09-05; the same
-- decision as interest and Christian Financial Resources). Every row on the
-- Internal Revenue Service under any spelling goes: Form 1120-POL income tax,
-- employer taxes, filing fees, and the handful of negative refund lines.
-- Matched on the whole name, letters only, so it is right before or after the
-- merge that folds the spellings together, on either database — and so that a
-- company merely containing "IRS" is not caught. The same rule runs at ingest
-- (pipeline.ts, isNonPoliticalMoney). Run everywhere, then rebuild.
DELETE FROM transactions t
 USING entities e
 WHERE e.id IN (t.from_entity_id, t.to_entity_id)
   AND regexp_replace(upper(e.name), '[^A-Z]', '', 'g')
       ~ '^(USTREASURY)?(IRS|INTERNALREVENUESERVICES?)(USTREASURY)?(VIAEFTPS)?$';
