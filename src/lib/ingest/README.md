# Ingestion adapters

Each source is one adapter that produces `RawContributionRow`s. The pipeline
(`pipeline.ts`) then resolves entities, writes transactions and rebuilds rollups —
adapters never touch the graph tables directly, so adding a jurisdiction never means
touching resolution or traversal logic.

## Implemented

### `fl-doe` — Florida Division of Elections

State-level races plus every state-registered committee. See the root README for the CGI
contract. Rate-limited and serialized; the upstream is a single SQL Server box behind
Cloudflare.

## The local-race gap

Florida splits campaign finance filing across three tiers, and only the first is covered:

| Tier | Offices | Files with |
| --- | --- | --- |
| State | Governor, Cabinet, **state House and Senate**, statewide judicial, all state PAC/CCE/ECO/IXO | Division of Elections |
| County | County commission, **school board**, sheriff, clerk, property appraiser, **special districts** (mosquito control, airport authority, hospital, water management) | County Supervisor of Elections (**67 of them**) |
| Municipal | Mayor, city council, city referenda | City clerk (**400+ municipalities**) |

So state representative and state senator races are already covered by `fl-doe`. County,
school board, city council and special-district races are **not**, and no aggregator
covers them well — this is the part that has to be built jurisdiction by jurisdiction.

### Adding a county or municipal adapter

1. Insert a `jurisdictions` row (`level: 'county' | 'municipal' | 'special_district'`,
   `parentId` pointing at Florida) and a `sources` row.
2. Implement a class exposing the same three primitives as `FlDoeAdapter`:
   - `contributionsToCommittee(name, opts)` — the upstream hop
   - `contributionsToCandidate(last, first, opts)` — the upstream hop for candidates
   - `contributionsFromContributor(name, opts)` — the downstream hop
3. Emit `RawContributionRow`s. `rowHash` must be stable across re-ingests and must
   incorporate a scope key, so the same filing seen through two queries dedupes to one
   transaction.
4. Pass the rows to `ingestContributionRows(db, rows, { sourceId, jurisdictionId })`.

Nothing else needs to change: resolution, rollups and the crawler are source-agnostic.

### Practical notes

- Several Florida counties run the same vendor software, so one adapter can often cover
  many counties by varying a base URL. Survey before writing 67 of them.
- Entity resolution is deliberately scoped by *name*, not jurisdiction, so a committee
  that gives at both state and county level resolves to a single node and the graph spans
  tiers automatically. That is the main payoff of doing this properly.
- Watch for the same truncation and address-drift problems documented in `normalize.ts`;
  county systems are usually worse, not better.

## Licensed sources

`Transparency USA` sells CSV/JSON/API access covering 25 states at state level. If
licensed, it slots in as another adapter. It does **not** solve the local-race gap above —
their FAQ scopes coverage to entities active in a state capital.
