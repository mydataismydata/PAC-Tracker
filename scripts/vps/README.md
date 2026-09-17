# Deploying, on the VPS

Run these from `~/PAC-Tracker` after `ssh ubuntu@51.81.49.136`. The delta they
load is put there by `./scripts/ship.sh` on the Mac, which builds it and copies
it and does nothing else.

| What changed | Run |
|---|---|
| Code only | `./scripts/vps/code.sh` |
| Code and data | `./scripts/vps/deploy.sh delta.sql.gz` |
| Data only | `./scripts/vps/data.sh delta.sql.gz` |
| Nothing, but a rebuild was skipped | `./scripts/vps/rebuild.sh` |
| Hand-written SQL | `./scripts/vps/sql.sh file.sql [more.sql]` |

Each one prints what it is doing and stops on the first failure.

## The rebuild

`data.sh` and `deploy.sh` rebuild at the end, and `--no-rebuild` skips it. Skip
it only to load several deltas back to back, then run `rebuild.sh` once.

`edge_rollups`, `entity_cycle_totals`, and the totals and degrees on `entities`
are all derived from `transactions`, and the delta ships none of them — that
would be 680 MB per sync. A load without a rebuild leaves every figure on the
site reading what it read before the delta arrived, and nothing says so.

`code.sh` does not rebuild, and should not. New code changes no filing, so the
stamp the cached traces and pictures are keyed on does not move and a week of
them survives the restart in the volume.

## Two things that have bitten

`docker compose build`, never `build app`. `app` builds `pactracker-app`;
`migrate` and `cli` both build a separate image, `pactracker-tools`. Building
only `app` leaves every ingest and every migration running the old code while
reporting success. `code.sh` does the plain build.

The app has to be up before the rebuild. The rebuild's last act is to ask it
for the reports it just emptied, so the twenty-five-second pages are warm
before a reader finds them. `deploy.sh` restarts the app first for that reason.

## Running one of these on the Mac

They refuse. `.exports/.last-sync` is the watermark the ingest keeps, it never
travels, and its presence is an exact test for the wrong machine. `data.sh`
there would load a delta the Mac already contains; `rebuild.sh` there would
spend twenty minutes rebuilding what the delta was made from. Set
`PT_ALLOW_ANYWHERE=1` if you mean it.
