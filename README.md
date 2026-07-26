# PAC Tracker

Interactive exploration of how money moves between political committees, candidates and
donors in Florida. Pick an entity, choose how many levels to crawl, and the graph builds
outward as the data streams in.

## What it does

- **Seed on any entity** — committee, candidate, corporation or individual.
- **Crawl _n_ levels** up (who funded them), down (where the money went), or both.
- **Direct vs donor links.** *Direct* follows only the committee-to-committee chain, which
  keeps the political money path readable. *Donor* additionally pulls in the individuals
  and corporations feeding each committee — the full funding base, and a far bigger graph.
- **Progressive rendering.** Each BFS level is streamed over SSE and drawn as it arrives,
  so the first tiles appear immediately instead of after the whole crawl.
- **Zoomable, pannable canvas** with draggable tiles. A tile you move is pinned, and later
  levels arrange themselves around your layout.
- **Saved searches** store the seed, the crawl parameters and the tile positions, so a
  reopened graph looks the way you left it.
- **PNG snapshot** of the current view.
- **Shareable URLs** — the address bar always reflects the current crawl.

## Quick start — Docker

Everything runs in Docker Desktop. This starts Postgres, applies migrations, and serves
the app on <http://localhost:3000>:

```bash
docker compose up -d --build
```

The database starts empty. Load data with the `cli` service — the committee registry
first (~7,600 committees, a few minutes), then a seed and a couple of expansion rounds:

```bash
docker compose run --rm cli ingest registry
```

```bash
docker compose run --rm cli ingest committee "Florida Chamber" --election=20241105-GEN
```

```bash
docker compose run --rm cli ingest expand 3
```

Other useful commands:

```bash
docker compose logs -f app
```

```bash
docker compose down
```

Data lives in the `pactracker-pgdata` volume and survives `down`. To wipe it, use
`docker compose down -v`.

### Services

| Service | Role |
| --- | --- |
| `db` | Postgres 16. Published on host port **5439** so host tooling still works. |
| `migrate` | One-shot. Applies migrations and creates `pg_trgm`, then exits. `app` waits on it. |
| `app` | The Next.js server on **3000**. |
| `cli` | Ingest CLI, `cli` profile — not started by `up`. Run it on demand as above. |

The scraper is never run automatically. It hits a live government service, so it stays an
explicit action.

## Quick start — local Node

If you would rather run the app on the host and keep only Postgres in Docker:

```bash
pnpm install && docker compose up -d db
```

```bash
cp .env.example .env && pnpm db:migrate && pnpm dev
```

`.env.example` points at `localhost:5439`, which is the same database the containers use.

## Data sources

### Florida Division of Elections (implemented)

The [campaign finance database](https://dos.elections.myflorida.com/campaign-finance/)
covers **state-level races and every state-registered committee** (PAC, CCE, ECO, ECI,
IXO, PAP, PTY), back to 1996.

There is no API. The adapter drives the same CGI endpoints the public search form uses:

| Endpoint | Purpose |
| --- | --- |
| `POST /cgi-bin/contrib.exe` | Contributions. `queryformat=2` returns tab-delimited text. |
| `POST /cgi-bin/expend.exe` | Expenditures. |
| `POST /committees/ComLkupByName.asp` | Committee registry, swept A–Z. |

Contract details that are not obvious and cost real time to rediscover:

- A `Referer` from the corresponding search page is required; without it Cloudflare
  answers `502`.
- `csort1` must be non-empty, or the CGI emits a bare `ORDER BY` and returns a SQL Server
  syntax error **inside an HTTP 200 body**.
- `rowlimit` is `maxlength=5`, so `99999` is the ceiling.
- `search_on` doubles as both the mode selector and the "what would you like to know?"
  choice: `1` contributor list, `2` candidate list, `3` candidate totals, `4` committee
  list, `5` committee totals.
- A blank committee-name search returns `500`; the registry has to be swept by prefix.

The backend is a single SQL Server box behind Cloudflare, so requests are serialized and
rate-limited (`FLDOE_REQUEST_DELAY_MS`, default 1500 ms).

### County, municipal and special-district races (not yet implemented)

**The Division of Elections does not hold these filings.** County commission, school
board, city council and special-district races — mosquito control, airport authority,
hospital and water management districts — are filed with the **67 county Supervisors of
Elections** and with individual city clerks, each with its own system.

Covering them means one adapter per jurisdiction behind the `sources` / `jurisdictions`
tables, which already model the distinction. See
[`src/lib/ingest/README.md`](src/lib/ingest/README.md).

### Others considered

- **Transparency USA** — 25 states, but **state-level only**, and they sell the data
  (CSV/JSON/API by quote). A licensed adapter would drop into the same interface.
- **FollowTheMoney.org** — free API, state-level, but data stops at 2024 while the site
  merges into OpenSecrets.
- **FEC** — public domain and excellent, but federal only.

## The hard part: entity resolution

Florida's export contains **no entity identifiers**. A recipient is the string
`Florida Chamber of Commerce PAC (PAC)` and a donor is the string
`SECURE FLORIDA'S FUTURE`. Nothing links a committee that *receives* money to the same
committee appearing as a *contributor* elsewhere — and without that link the graph has no
edges to traverse past the first hop.

Two properties of the real data make this harder:

- **Names are truncated at 40 characters.** `Florida Chamber of Commerce Alliance, Inc.`
  arrives as `Florida Chamber of Commerce Alliance, In`.
- **The same organization files under different addresses.** Secure Florida's Future
  appears under both ZIP 32301 and 32302 in the same 2024 cycle.

`src/lib/ingest/resolve.ts` works cheapest-first: in-process cache → exact normalized name
→ known alias → prefix match for truncated strings → trigram shortlist scored with address
signals → create a new entity. Every spelling ever seen is recorded in `entity_aliases`,
so any variant resolves to the same node next time.

The auto-link threshold (0.88) is deliberately high. **A false merge invents money flows
that do not exist**, which is much worse here than leaving two nodes unlinked. Near misses
are stored as low-confidence aliases for review rather than merged. In practice that keeps
`Florida Chamber of Commerce PAC`, `…CCE`, `…Alliance` and `Florida Chambers of Commerce
ECO` correctly separate (they score 0.70–0.80) while reuniting the truncated Alliance name
at 0.95.

### Traversability is derived, not declared

A node is worth expanding if money flows *into* it, not because it appears in the
committee registry. Some of the largest conduits in the live data are 501(c)(4)
corporations that never register as committees — Secure Florida's Future sent $2.0M,
$1.5M and $1.1M to a single committee in 2024 without appearing in the registry at all.
`refreshTraversability()` promotes any entity that has ever received money.

## Architecture

```
src/
  db/schema.ts              entities · aliases · transactions · edge_rollups · saved_searches
  lib/normalize.ts          name normalization, truncation + fuzzy match scoring
  lib/ingest/
    fl-doe/{client,parse,adapter}.ts   rate-limited scraper, TSV + registry parsers
    resolve.ts              entity resolution
    pipeline.ts             rows → entities → transactions → rollups
  lib/graph/crawl.ts        BFS crawler, yields one level at a time
  app/api/graph/stream      SSE endpoint
  components/GraphCanvas    Cytoscape canvas
```

`edge_rollups` pre-aggregates entity→entity totals so expansion is one indexed read per
hop. US Sugar's five separate $250k cheques to the Florida Chamber PAC in 2024 render as a
single $1.25M edge rather than five.

## Scripts

| Command | Description |
| --- | --- |
| `pnpm ingest registry` | Sweep the committee registry A–Z (~7,600 committees). |
| `pnpm ingest committee "<name>"` | Contributions *into* matching committees. |
| `pnpm ingest contributor "<name>"` | Contributions *out of* a contributor. |
| `pnpm ingest candidate "<last>"` | Contributions into a candidate. |
| `pnpm ingest expand <rounds>` | Grow the frontier outward automatically. |
| `pnpm ingest rebuild` | Recompute all rollups and totals. |
| `pnpm probe:fldoe` | Live smoke test of the scraping contract, no DB needed. |

Common flags: `--election=20241105-GEN`, `--limit=2000`, `--min=1000`, `--frontier=12`.

In Docker, the same commands run as `docker compose run --rm cli ingest <args>`.

## Caveats

- Coverage is **Florida state-level only** so far. See above.
- Data is only as complete as what you have ingested; the crawler cannot show an edge it
  has never fetched.
- Entity resolution is good, not perfect. `FLORIDA CHAMBER PAC` and `Florida Chamber of
  Commerce PAC` are almost certainly the same organization but score 0.767 and remain
  separate pending review.
- Amounts are as-reported. In-kind contributions are included and flagged, not netted out.

## Licence

Not yet chosen. The underlying campaign finance records are Florida public records.
