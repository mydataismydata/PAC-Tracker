#!/usr/bin/env bash
# New data, no new code. Run on the VPS.
#
# Usage:
#   ./scripts/vps/data.sh delta.sql.gz
#   ./scripts/vps/data.sh delta.sql.gz --no-rebuild
#
# The rebuild is not optional and the flag is not a convenience. edge_rollups,
# entity_cycle_totals and the totals and degrees on entities are all derived
# from transactions, and the delta ships none of them — 680 MB per sync is why.
# Loading without rebuilding leaves every figure on the site reading whatever it
# read before the delta arrived, and nothing says so.
#
# Skip it only to load several deltas back to back, and rebuild after the last.
# Resolved before the library is sourced, because sourcing it changes the
# working directory and a relative path would stop meaning this directory.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/_lib.sh"

file=${1:-}
need_file "$file"
rebuild=true
[[ ${2:-} == --no-rebuild ]] && rebuild=false

say "Loading $file"
psql_file "$file"

# Before the rebuild as well as after it. The rebuild ends with the same check,
# but a delta that left a merged-away entity referenced is a fact worth having
# before spending twenty minutes on top of it.
say 'Checking referential integrity'
cli ingest verify

if $rebuild; then
  say 'Rebuilding derived tables'
  cli ingest rebuild
else
  echo
  echo 'Rebuild skipped. Every derived figure is stale until you run:'
  echo '  ./scripts/vps/rebuild.sh'
fi
