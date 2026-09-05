-- PUBLIX SUPER MARKETS, INC. was re-kinded from committee to organization
-- (corrections.jsonl set-kind, 2026-09-04). Its industry label 'Political
-- committee' came with the misclassification; a grocery chain is Retail.
-- `ingest backfill-industry` only fills NULLs and `--force` would reclassify
-- every reviewed entity, so the one label is set directly.
UPDATE entities
   SET industry = 'Retail'
 WHERE id = 'a4ff642f-28f8-416b-9ee3-338909612357'
   AND name = 'PUBLIX SUPER MARKETS, INC.';
