#!/usr/bin/env bash
# New code and new data. Run on the VPS.
#
# Usage:
#   ./scripts/vps/deploy.sh delta.sql.gz
#   ./scripts/vps/deploy.sh delta.sql.gz --no-rebuild
#
# Code first, data second. Two reasons, and they point the same way: a delta
# may carry rows a migration has to exist for, and the rebuild's last act is to
# ask the running app for the reports it just emptied — which warms the old
# container if the new one is not up yet.
# Resolved before the library is sourced, because sourcing it changes the
# working directory and a relative path would stop meaning this directory.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/_lib.sh"

file=${1:-}
need_file "$file"

"$HERE/code.sh"
"$HERE/data.sh" "$@"
