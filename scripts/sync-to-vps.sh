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
ENTITIES="SELECT * FROM entities WHERE created_at > '$SINCE' OR updated_at > '$SINCE'"
# On transactions the same column is precise: nothing but a real change to the
# row sets it, because the rollup refresh writes to entities and never here.
TXNS="SELECT * FROM transactions WHERE ingested_at > '$SINCE' OR updated_at > '$SINCE'"
TOMBS="SELECT * FROM entity_tombstones WHERE deleted_at > '$SINCE'"

echo "since $SINCE"
echo "  entities:     $(q "SELECT count(*) FROM ($ENTITIES) x")"
echo "  transactions: $(q "SELECT count(*) FROM ($TXNS) x")"
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

{
  echo "BEGIN;"

  # Reference tables are tiny; upsert them so a newly added county source or
  # jurisdiction reaches the far side before anything referencing it does.
  for t in sources jurisdictions; do
    docker exec -i pactracker-db psql -U pactracker -d "$DB" -tAc \
      "SELECT format('INSERT INTO $t SELECT (%L::$t).* ON CONFLICT (id) DO NOTHING;', x) FROM $t x"
  done

  # Parents before children: entities, then the rows pointing at them.
  stage entities "$ENTITIES"
  echo "INSERT INTO entities SELECT * FROM _sync_entities"
  echo "  ON CONFLICT (id) DO UPDATE SET $ENTITY_SET;"
  echo "DROP TABLE _sync_entities;"

  stage transactions "$TXNS"
  echo "INSERT INTO transactions SELECT * FROM _sync_transactions"
  echo "  ON CONFLICT (id) DO UPDATE SET $TXN_SET;"
  echo "DROP TABLE _sync_transactions;"

  # Registrations and officers mutate in place (is_current flips), so replace
  # them wholesale rather than trying to diff. Both are under 2 MB.
  for t in committee_registrations committee_officers officer_aliases; do
    echo "TRUNCATE $t CASCADE;"
    echo "COPY $t FROM stdin;"
    copy "SELECT * FROM $t"
    printf '\\.\n'
  done

  # Deletions last, once everything that was reassigned off these entities has
  # already moved. Merged-away ids are carried too, so the far side can answer
  # for a stale link instead of 404ing on one.
  stage entity_tombstones "$TOMBS"
  echo "INSERT INTO entity_tombstones SELECT * FROM _sync_entity_tombstones"
  echo "  ON CONFLICT (id) DO NOTHING;"
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
  docker compose run --rm cli ingest rebuild

The rebuild is not optional. Reattributing money leaves edge_rollups and
entity_cycle_totals describing where it used to be.
NEXT
