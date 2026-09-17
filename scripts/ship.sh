#!/usr/bin/env bash
# Build the delta and put it on the VPS. Run on the Mac.
#
# Usage:
#   ./scripts/ship.sh                            # build the delta, ship it
#   ./scripts/ship.sh migrations/manual/x.sql    # ship that alongside it
#   ./scripts/ship.sh --no-delta file.sql        # ship the file on its own
#
# This copies files and nothing else. It does not log in and it does not load
# anything: the load is a separate decision made on the far side, by one of the
# scripts in scripts/vps/, and a copy that silently applied itself would make
# "did the delta land?" and "did it apply?" the same question. They are not.
#
# `sync-to-vps.sh` advances the watermark in .exports/.last-sync when it
# succeeds, so the delta it wrote is the only copy of the rows between the last
# sync and this one. Ship it. A delta built and thrown away leaves a hole
# nothing later fills.
set -euo pipefail
cd "$(dirname "$0")/.."

VPS=${VPS:-ubuntu@51.81.49.136}
DEST=${DEST:-PAC-Tracker}

delta=true
if [[ ${1:-} == --no-delta ]]; then
  delta=false
  shift
fi

# Named files are checked before anything is built, so a typo costs nothing
# rather than costing a delta that then has to be shipped by hand.
for f in "$@"; do
  [[ -f $f ]] || { echo "no such file: $f" >&2; exit 1; }
done

files=()
if $delta; then
  ./scripts/sync-to-vps.sh
  files+=(.exports/delta.sql.gz)
fi
files+=("$@")

if [[ ${#files[@]} -eq 0 ]]; then
  echo "nothing to ship — pass files, or drop --no-delta" >&2
  exit 1
fi

echo
echo "Shipping to $VPS:$DEST/"
for f in "${files[@]}"; do echo "  $f"; done
scp "${files[@]}" "$VPS:$DEST/"

cat <<NEXT

Landed. Now, on the VPS:

  ssh $VPS
  cd ~/$DEST

and one of:

  ./scripts/vps/deploy.sh delta.sql.gz   # code and data, then rebuild
  ./scripts/vps/data.sh   delta.sql.gz   # data only, then rebuild
  ./scripts/vps/code.sh                  # code only
NEXT
