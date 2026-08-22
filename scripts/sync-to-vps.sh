#!/usr/bin/env bash
# Export everything the VPS is missing since the last sync.
#
# Derived tables (edge_rollups, entity_cycle_totals, entity totals) are NOT
# shipped — the far side rebuilds them from transactions, which is far cheaper
# than moving 680 MB. entity_aliases is ingest-only and lives empty on the VPS.
set -euo pipefail
cd "$(dirname "$0")/.."

DB=${DB:-pactracker}
OUT=.exports/delta.sql
MARK=.exports/.last-sync
SINCE=$(cat "$MARK" 2>/dev/null || echo '1970-01-01')
NOW=$(docker exec -i pactracker-db psql -U pactracker -d "$DB" -tAc "SELECT now()")

q()    { docker exec -i pactracker-db psql -U pactracker -d "$DB" -tAc "$1"; }
copy() { docker exec -i pactracker-db psql -U pactracker -d "$DB" -c "\copy ($1) TO STDOUT"; }

echo "since $SINCE"
echo "  transactions: $(q "SELECT count(*) FROM transactions WHERE ingested_at > '$SINCE'")"
echo "  entities:     $(q "SELECT count(*) FROM entities WHERE created_at > '$SINCE'")"

{
  echo "BEGIN;"

  # Reference tables are tiny; upsert them so a newly added county source or
  # jurisdiction reaches the far side before anything referencing it does.
  for t in sources jurisdictions; do
    docker exec -i pactracker-db psql -U pactracker -d "$DB" -tAc \
      "SELECT format('INSERT INTO $t SELECT (%L::$t).* ON CONFLICT (id) DO NOTHING;', x) FROM $t x"
  done

  # Parents before children: entities, then the rows pointing at them.
  echo "COPY entities FROM stdin;"
  copy "SELECT * FROM entities WHERE created_at > '$SINCE'"
  echo '\.'

  echo "COPY transactions FROM stdin;"
  copy "SELECT * FROM transactions WHERE ingested_at > '$SINCE'"
  echo '\.'

  # Registrations and officers mutate in place (is_current flips), so replace
  # them wholesale rather than trying to diff. Both are under 2 MB.
  for t in committee_registrations committee_officers officer_aliases; do
    echo "TRUNCATE $t CASCADE;"
    echo "COPY $t FROM stdin;"
    copy "SELECT * FROM $t"
    echo '\.'
  done

  echo "COMMIT;"
} > "$OUT"

gzip -9 -f "$OUT"
echo "$NOW" > "$MARK"
ls -lh "$OUT.gz"
