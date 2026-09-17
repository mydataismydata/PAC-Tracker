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

say 'Pulling'
git pull

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
