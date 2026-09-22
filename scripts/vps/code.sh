#!/usr/bin/env bash
# New code, no new data. Run on the VPS.
#
# Usage: ./scripts/vps/code.sh
#
# No rebuild, deliberately. A code deploy changes no filing, so the stamp the
# cached traces and pictures are keyed on does not move and a week of them
# survives the restart in the volume. Rebuilding here would cost twenty minutes
# to arrive at the numbers already on screen.
# Resolved before the library is sourced, because sourcing it changes the
# working directory and a relative path would stop meaning this directory.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/_lib.sh"

say 'Fetching'
git fetch --prune origin

# Take the remote exactly, rather than pulling it.
#
# This box holds no work of its own, so there is nothing here to reconcile a
# pull against. A pull still tries: it walks two histories looking for a shared
# base, and a history that was rewritten on the Mac no longer has one. It stops
# with "divergent branches" and the deploy stops with it.
#
# --hard moves tracked files only. docker-compose.override.yml, .env, .exports
# and .working are all ignored here, and none of them are touched.
if ! git diff --quiet HEAD --; then
  cat >&2 <<'DIRTY'
Tracked files here have been edited, and the next step would discard them.

Look at them with `git status`. Keep them with `git stash`, or throw them away
with `git checkout -- .`. Then run this again.
DIRTY
  exit 1
fi

say 'Taking origin/main'
git reset --hard origin/main

# Plain `build`, never `build app`. `app` builds pactracker-app; `migrate` and
# `cli` both build a separate image, pactracker-tools. Building only `app`
# leaves every ingest and migration running last week's code while reporting
# success.
say 'Building images (10-25 min on 2 vCore)'
docker compose build

say 'Applying migrations'
docker compose up -d migrate

say 'Restarting the app'
docker compose up -d app

say 'Status'
docker compose ps
echo
echo 'app should read "Up (healthy)". Give the health check ~20s if it does not yet.'
