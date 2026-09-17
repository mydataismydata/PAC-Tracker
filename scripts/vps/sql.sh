#!/usr/bin/env bash
# Run hand-written SQL against the serving database. Run on the VPS.
#
# Usage:
#   ./scripts/vps/sql.sh unfold-sponsor-selfloops.sql
#   ./scripts/vps/sql.sh first.sql second.sql       # in the order given
#
# The escape hatch for surgery the corrections log cannot express, which is
# recorded there as a `manual-sql` entry and never executed by the replay.
# Order is the order you give, because these usually depend on each other.
#
# No rebuild. What one of these changes is the caller's to know, so the rebuild
# is theirs to decide.
# Resolved before the library is sourced, because sourcing it changes the
# working directory and a relative path would stop meaning this directory.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/_lib.sh"

[[ $# -gt 0 ]] || { echo 'name at least one .sql file' >&2; exit 1; }
for f in "$@"; do need_file "$f"; done

for f in "$@"; do
  say "Running $f"
  psql_file "$f"
done

say 'Checking referential integrity'
cli ingest verify

echo
echo 'If that changed any money or any entity, rebuild:'
echo '  ./scripts/vps/rebuild.sh'
