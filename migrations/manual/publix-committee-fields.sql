-- Companion to the Publix set-kind (2026-09-04). committee_type = 'ECO' and
-- status = 'closed' came with the committee misclassification; every other
-- organization carries NULL and 'unknown', and the panel labels a node by its
-- committee_type whenever one is set, so the corporation still read as an
-- Electioneering Comm. Org. updated_at is bumped so the row ships in the delta.
UPDATE entities
   SET committee_type = NULL,
       status = 'unknown',
       updated_at = now()
 WHERE id = 'a4ff642f-28f8-416b-9ee3-338909612357'
   AND name = 'PUBLIX SUPER MARKETS, INC.';
