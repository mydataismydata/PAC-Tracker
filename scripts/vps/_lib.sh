#!/usr/bin/env bash
# Shared by the scripts in this directory. Not runnable on its own.
#
# Every one of these does something to the serving database or the serving
# containers, so the first thing any of them does is refuse to run on the
# machine the data is built on. `.exports/.last-sync` is the watermark
# `sync-to-vps.sh` keeps, it is gitignored, and it exists only where the
# ingest runs — which makes it an exact test for "this is the wrong machine".
#
# Getting that wrong is not a small mistake. `data.sh` on the Mac would load a
# delta the Mac already contains, and `rebuild.sh` there would spend twenty
# minutes rebuilding the thing the delta was made from.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

DB=${DB:-pactracker}
DB_CONTAINER=${DB_CONTAINER:-pactracker-db}

if [[ -f .exports/.last-sync && ${PT_ALLOW_ANYWHERE:-} != 1 ]]; then
  cat >&2 <<'WRONG'
This is the machine the delta is built on, not the machine it is loaded on.
.exports/.last-sync is here, and that file never travels.

Run this on the VPS. If you really mean to run it here, set PT_ALLOW_ANYWHERE=1.
WRONG
  exit 1
fi

say() { printf '\n== %s\n' "$*"; }

# One SQL file into the serving database, all or nothing.
#
# ON_ERROR_STOP with the implicit transaction the loader wraps itself in means
# a failure commits nothing. A partial load is the one outcome worth ruling
# out: half a delta is a database that disagrees with itself and says nothing
# about which half it kept.
psql_file() {
  local file=$1
  case $file in
    *.gz) gunzip -c "$file" ;;
    *)    cat "$file" ;;
  esac | docker exec -i "$DB_CONTAINER" psql -U "$DB" -d "$DB" -v ON_ERROR_STOP=1
}

need_file() {
  [[ -n ${1:-} ]] || { echo "${0##*/}: name the file to load" >&2; exit 1; }
  [[ -f $1 ]] || { echo "${0##*/}: no such file: $1" >&2; exit 1; }
}

cli() { docker compose run --rm cli "$@"; }
