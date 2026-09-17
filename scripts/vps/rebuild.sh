#!/usr/bin/env bash
# Re-derive every rollup and total, then warm the reports. Run on the VPS.
#
# Usage: ./scripts/vps/rebuild.sh
#
# For after a `--no-rebuild` load, or after a hand-run SQL file changed rows.
# Ends by confirming no merged-away entity survived, and by asking the app for
# the reports the rebuild made stale, so no reader pays for the first one.
# Resolved before the library is sourced, because sourcing it changes the
# working directory and a relative path would stop meaning this directory.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/_lib.sh"

say 'Rebuilding derived tables'
cli ingest rebuild
