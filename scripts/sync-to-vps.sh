#!/usr/bin/env bash
# Export everything the VPS is missing since the last sync.
#
# Two kinds of change have to travel, and they are not the same shape.
#
# New filings are inserts, and they are the easy half: rows that did not exist
# over there, identified by when they were loaded.
#
# Corrections are the other half, and they are edits and deletions of rows that
# already exist on both sides. Reattributing a candidate's money off the wrong
# person changes no row's load time, so a delta keyed on load time ships none
# of it — the far side keeps the wrong answer indefinitely and nothing says so.
# Everything here is therefore an upsert, keyed on the id, and deletions travel
# as tombstones.
#
# Derived tables (edge_rollups, entity_cycle_totals, entity totals) are NOT
# shipped — the far side rebuilds them from transactions with `ingest rebuild`,
# which is far cheaper than moving 680 MB. entity_aliases is ingest-only and
# lives empty on the VPS.
set -euo pipefail
cd "$(dirname "$0")/.."

DB=${DB:-pactracker}
OUT=.exports/delta.sql
MARK=.exports/.last-sync
SINCE=$(cat "$MARK" 2>/dev/null || echo '1970-01-01')
NOW=$(docker exec -i pactracker-db psql -U pactracker -d "$DB" -tAc "SELECT now()")

q()    { docker exec -i pactracker-db psql -U pactracker -d "$DB" -tAc "$1"; }
copy() { docker exec -i pactracker-db psql -U pactracker -d "$DB" -c "\copy ($1) TO STDOUT"; }

# An entity is worth shipping if anything about it changed, not just if it is
# new. `updated_at` on entities is noisy — the rollup refresh bumps every row
# it touches — but the rows are small and the write is idempotent, so shipping
# a few thousand unchanged ones costs far less than missing one real edit.
# The changed entities, plus every entity a tombstone resolves to. A merge's
# survivor may predate the watermark and so miss the delta, yet the far side
# needs it present to repoint a straggler onto it before the tombstone delete
# below. Resolve merge chains to the terminal, non-tombstoned id.
ENTITIES="
WITH RECURSIVE chain AS (
  SELECT id AS tomb_id, merged_into AS cur, 1 AS depth FROM entity_tombstones
  UNION ALL
  SELECT c.tomb_id, t.merged_into, c.depth + 1
    FROM chain c JOIN entity_tombstones t ON t.id = c.cur
   WHERE c.depth < 50
),
survivors AS (
  SELECT DISTINCT cur AS id FROM chain c
   WHERE cur IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM entity_tombstones t2 WHERE t2.id = c.cur)
)
SELECT e.* FROM entities e
 WHERE e.created_at > '$SINCE' OR e.updated_at > '$SINCE'
    OR e.id IN (SELECT id FROM survivors)"
# On transactions the same column is precise: nothing but a real change to the
# row sets it, because the rollup refresh writes to entities and never here.
TXNS="SELECT * FROM transactions WHERE ingested_at > '$SINCE' OR updated_at > '$SINCE'"
# Every tombstone, not only the recent ones. They are tiny (a few hundred
# rows), the far-side apply is idempotent, and shipping the whole set lets the
# repoint below resolve a merge chain that reaches back past the watermark, and
# clears any entity a missed delta left un-deleted over there.
TOMBS="SELECT * FROM entity_tombstones"
# Every transaction tombstone, for the same reasons as the entity ones: they
# are small, the apply is idempotent, and shipping the whole set clears a row
# that a missed delta left alive over there.
TXN_TOMBS="SELECT * FROM transaction_tombstones"

echo "since $SINCE"
echo "  entities:     $(q "SELECT count(*) FROM ($ENTITIES) x")"
echo "  transactions: $(q "SELECT count(*) FROM ($TXNS) x")"
echo "  txn deletes:  $(q "SELECT count(*) FROM ($TXN_TOMBS) x")"
echo "  deletions:    $(q "SELECT count(*) FROM ($TOMBS) x")"

# Upsert a set of rows through a staging table.
#
# COPY cannot upsert and these ids already exist on the far side, so the rows
# land in an unlogged copy of the table and are merged from there. `LIKE ...
# INCLUDING DEFAULTS` keeps the column order identical to the real table, which
# is what lets the same COPY body serve both.
stage() {
  local table=$1 query=$2
  cat <<SQL
CREATE UNLOGGED TABLE _sync_$table (LIKE $table INCLUDING DEFAULTS);
COPY _sync_$table FROM stdin;
SQL
  copy "$query"
  printf '\\.\n'
}

# Build the SET clause for an upsert from the table's own columns, minus the
# primary key. Read from the local schema so a column added later is carried
# without anyone having to remember this file exists.
setclause() {
  q "SELECT string_agg(format('%I = EXCLUDED.%I', column_name, column_name), ', ' ORDER BY ordinal_position)
       FROM information_schema.columns
      WHERE table_name = '$1' AND table_schema = 'public' AND column_name <> 'id'"
}

ENTITY_SET=$(setclause entities)
TXN_SET=$(setclause transactions)
TOMB_SET=$(setclause entity_tombstones)
TXN_TOMB_SET=$(setclause transaction_tombstones)
JURISDICTION_SET=$(setclause jurisdictions)
SOURCE_SET=$(setclause sources)

{
  echo "BEGIN;"

  # Reference tables are tiny; upsert them so a newly added county source or
  # jurisdiction reaches the far side before anything referencing it does.
  #
  # Jurisdictions first: `sources.jurisdiction_id` points at them, so emitting
  # sources first fails the foreign key the moment a source arrives with a
  # jurisdiction the far side has never seen. That stayed hidden while every
  # new source reused a jurisdiction the last full dump already carried, and
  # broke on the first genuinely new one — US-FEC, for the federal loader.
  #
  # Upserted rather than inserted-if-absent. A feed that is renamed, or pointed
  # at a different jurisdiction, changes a row that already exists on the far
  # side, and `DO NOTHING` left it reading whatever it read the day it was
  # created. The methods page prints these names, so the two would disagree in
  # public.
  for t in jurisdictions sources; do
    case $t in
      jurisdictions) set_clause=$JURISDICTION_SET ;;
      sources)       set_clause=$SOURCE_SET ;;
    esac
    docker exec -i pactracker-db psql -U pactracker -d "$DB" -tAc \
      "SELECT format('INSERT INTO $t SELECT (%L::$t).* ON CONFLICT (id) DO UPDATE SET $set_clause;', x) FROM $t x"
  done

  # Deleted transactions go first, before anything else touches the table.
  #
  # A delta carries inserts, updates and entity tombstones. Until this table
  # existed it carried no deletions, so every row this machine deleted after
  # having shipped it lived on over there for good — and the far side could not
  # repair it in its own rebuild, because mirror collapse only pairs rows that
  # already sit between the same two nodes and a row the correction never
  # reached still points at the old one.
  #
  # Before the transaction upsert, for two reasons. `source_row_hash` is
  # uniquely indexed and the upsert below resolves on `id`, so a filing that was
  # deleted here and brought back by a later sweep arrives under a new id and
  # collides with the old row's hash — which aborts the whole delta unless the
  # old row goes first. And a stray still pointing at an entity the tombstones
  # below delete is better deleted than repointed onto the survivor.
  stage transaction_tombstones "$TXN_TOMBS"
  echo "INSERT INTO transaction_tombstones SELECT * FROM _sync_transaction_tombstones"
  echo "  ON CONFLICT (id) DO UPDATE SET $TXN_TOMB_SET;"
  echo "DELETE FROM transactions t USING _sync_transaction_tombstones d WHERE t.id = d.id;"
  echo "DROP TABLE _sync_transaction_tombstones;"

  # Parents before children: entities, then the rows pointing at them.
  stage entities "$ENTITIES"
  echo "INSERT INTO entities SELECT * FROM _sync_entities"
  echo "  ON CONFLICT (id) DO UPDATE SET $ENTITY_SET;"
  echo "DROP TABLE _sync_entities;"

  stage transactions "$TXNS"
  echo "INSERT INTO transactions SELECT * FROM _sync_transactions"
  echo "  ON CONFLICT (id) DO UPDATE SET $TXN_SET;"
  echo "DROP TABLE _sync_transactions;"

  # Registrations, officers, and org profiles mutate in place (is_current flips,
  # a 990 figure is revised), so replace them wholesale rather than trying to
  # diff. All are small. Their rows reference entities, which are already loaded.
  for t in committee_registrations committee_officers officer_aliases org_profiles; do
    echo "TRUNCATE $t CASCADE;"
    echo "COPY $t FROM stdin;"
    copy "SELECT * FROM $t"
    printf '\\.\n'
  done

  # Deletions last, once everything that was reassigned off these entities has
  # already moved. Merged-away ids are carried too, so the far side can answer
  # for a stale link instead of 404ing on one.
  #
  # Every column, through the same helper the other tables use. This named
  # `merged_into` by hand, which was invisible for as long as a tombstone had
  # nothing else on it. It now carries what was folded — the name, the kind and
  # the feed — and all 1,664 of these already exist on the far side, so every
  # one takes the DO UPDATE branch and none of the new columns ever arrived.
  stage entity_tombstones "$TOMBS"
  echo "INSERT INTO entity_tombstones SELECT * FROM _sync_entity_tombstones"
  echo "  ON CONFLICT (id) DO UPDATE SET $TOMB_SET;"

  # Repoint any transaction that still references a tombstoned id onto the
  # entity it was merged into, before deleting the id. Locally these rows moved
  # long ago, but a transaction the far side deleted on its own (mirror-collapse
  # runs in its rebuild, not this load) or one from a delta it never received
  # still points at the doomed id over there, and the foreign key would block
  # the delete. Resolve merge chains to the terminal, non-tombstoned survivor.
  cat <<'SQL'
CREATE TEMP TABLE _sync_tomb_survivor ON COMMIT DROP AS
WITH RECURSIVE chain AS (
  SELECT id AS tomb_id, merged_into AS cur, 1 AS depth FROM _sync_entity_tombstones
  UNION ALL
  SELECT c.tomb_id, t.merged_into, c.depth + 1
    FROM chain c JOIN _sync_entity_tombstones t ON t.id = c.cur
   WHERE c.depth < 50
)
SELECT tomb_id, cur AS survivor FROM chain c
 WHERE cur IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM _sync_entity_tombstones t2 WHERE t2.id = c.cur);
UPDATE transactions x SET from_entity_id = s.survivor
  FROM _sync_tomb_survivor s WHERE x.from_entity_id = s.tomb_id;
UPDATE transactions x SET to_entity_id = s.survivor
  FROM _sync_tomb_survivor s WHERE x.to_entity_id = s.tomb_id;
SQL
  echo "DELETE FROM entities e USING _sync_entity_tombstones t WHERE e.id = t.id;"
  echo "DROP TABLE _sync_entity_tombstones;"

  echo "COMMIT;"
} > "$OUT"

gzip -9 -f "$OUT"
echo "$NOW" > "$MARK"
ls -lh "$OUT.gz"

cat <<'NEXT'

Ship it:
  scp .exports/delta.sql.gz vps:~/PAC-Tracker/
On the VPS:
  gunzip -c delta.sql.gz | docker exec -i pactracker-db psql -U pactracker -d pactracker -v ON_ERROR_STOP=1
  docker compose run --rm cli ingest verify
  docker compose run --rm cli ingest rebuild

The load runs in one transaction under ON_ERROR_STOP: if it prints ERROR it
committed nothing and nothing landed — read the error, fix it, re-run. A clean
exit means the whole delta applied, including the tombstone deletes.

`ingest verify` then confirms no merged-away entity is still present or
referenced — the Driskell block. It must say "clean". (rebuild runs the same
check at its end, so a standalone verify is belt-and-suspenders.)

The rebuild is not optional. Reattributing money leaves edge_rollups and
entity_cycle_totals describing where it used to be.
NEXT
