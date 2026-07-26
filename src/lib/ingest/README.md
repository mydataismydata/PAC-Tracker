# Ingestion adapters

Each source is one adapter that produces `RawTransactionRow`s (`../types.ts`). The
pipeline (`pipeline.ts`) then resolves entities, writes transactions and rebuilds rollups —
adapters never touch the graph tables directly, so adding a jurisdiction never means
touching resolution or traversal logic.

Rows are normalized to **filer + counterparty + direction** rather than donor/recipient,
because sources disagree about what a row is. The state feed lists contributions only,
described from the recipient's side. County feeds interleave contributions and
expenditures, described from the filer's side. One shape covers both and keeps
expenditures — money leaving a committee — in the graph.

## Implemented

### `fl-doe` — Florida Division of Elections

State-level races plus every state-registered committee. See the root README for the CGI
contract. Rate-limited and serialized; the upstream is a single SQL Server box behind
Cloudflare.

### `voterfocus-<county>` — county Supervisors of Elections

Covers the county tier: county commission, school board, city commission, and special
districts (mosquito control, airport authority, port and waterway, CDDs).

VoterFocus (VR Systems) hosts the portal for a large share of Florida's 67 counties, and
**the county is a single query parameter** — so one adapter serves all of them. Twenty
slugs are verified in `voterfocus/counties.ts`, including Miami-Dade, Broward, Palm Beach,
Hillsborough, Orange and Duval.

```bash
pnpm ingest counties          # list supported counties
pnpm ingest county stjohns    # sweep one
```

Contract details worth knowing:

| Endpoint | Purpose |
| --- | --- |
| `candidate_pr.php?c=<slug>&e=<election>` | Candidate/committee index for a cycle. |
| `export.php?op=CFINANCE&cand_id=<id>&county=<slug>` | Per-entity CSV, contributions **and** expenditures. |

- The `/ws/WScand/` path 302s to `/CampaignFinance/`. POST there directly — following the
  redirect drops the body and the origin answers `411`.
- A PHP session cookie is required, so the form page is fetched once before any export.
- **Use the per-entity export, not the transaction search form.** The search is scoped to
  whatever election the session has selected and returns an empty result set more often
  than not; `export.php` is addressed by id and just works.
- The index page carries `Office:` headings above each group of candidates, so office
  comes free without a request per candidate. Names live in the first `role="gridcell"`
  div — taking the anchor's whole text appends a screen-reader "status" to every name.
- Committees are flagged by `committee=Y` in the link, and are not filed against an office.

This source is **richer than the state feed**: ISO dates, expenditures inline, and a real
`cont. type` code (`I` individual, `B` business, `C` committee, `P` party, `O` other,
`S` self). That code feeds `ResolveInput.kindHint`, so a county committee is identified as
a committee from evidence rather than from a name heuristic.

## The remaining gap

| Tier | Offices | Files with | Status |
| --- | --- | --- | --- |
| State | Governor, Cabinet, state House and Senate, statewide judicial, all state PAC/CCE/ECO/IXO | Division of Elections | **covered** |
| County | County commission, school board, sheriff, clerk, special districts | County Supervisor of Elections (67) | **covered where VoterFocus is used** |
| Municipal | Mayor, city council, city referenda | City clerk (400+) | partly — larger cities appear in the county portal, standalone clerks do not |

Counties not on VoterFocus need their own adapter. Survey the vendor before writing one:
several run the same software under a different domain, so the existing parser may only
need a new base URL.

### Adding an adapter

1. Insert a `jurisdictions` row and a `sources` row — `ensureCountySource` in
   `pipeline.ts` shows the shape.
2. Emit `RawTransactionRow`s. `rowHash` must be stable across re-ingests and must include
   a source-scoped key, so the same filing seen twice dedupes to one transaction.
3. Pass them to `ingestTransactionRows(db, rows, { sourceId, jurisdictionId })`.

Nothing else changes: resolution, rollups and the crawler are source-agnostic.

### Why this spans tiers automatically

Entity resolution matches on **name, deliberately ignoring jurisdiction**. So a committee
that gives at both levels collapses to one node and the graph crosses tiers by itself —
the Republican Party of Florida's $6,000 to the St. Johns County Republican Executive
Committee links a $13M state committee to a county school board race with no special
handling.

## Licensed sources

Transparency USA sells CSV/JSON/API access covering 25 states at state level. If licensed,
it slots in as another adapter. It does **not** solve the local-race gap — their FAQ scopes
coverage to entities active in a state capital.
