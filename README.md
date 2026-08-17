# PAC Tracker

Interactive exploration of how money moves between political committees, candidates and
donors in Florida. Pick an entity, choose how many levels to crawl, and the graph builds
outward as the data streams in.

## What it does

- **Seed on any entity** — committee, candidate, corporation or individual. Picking one
  from search selects it, fills the detail panel, and flies the camera to its tile with
  its neighbourhood highlighted.
- **Crawl _n_ levels** up (who funded them), down (where the money went), or both.
- **Direct vs donor links.** *Direct* follows only the committee-to-committee chain, which
  keeps the political money path readable. *Donor* additionally pulls in the individuals
  and corporations feeding each committee — the full funding base, and a far bigger graph.
- **Progressive rendering.** Each BFS level is streamed over SSE and drawn as it arrives,
  so the first tiles appear immediately instead of after the whole crawl.
- **Zoomable, pannable canvas** with draggable tiles. A tile you move is pinned, and later
  levels arrange themselves around your layout.
- **Full ledger per entity.** Selecting a tile lists *every* counterparty and *every*
  individual transaction from the database — not just the edges the crawl happened to
  draw. Filter by name, sort, page through, and export to CSV. The totals reconcile
  against the tile, so a candidate showing "297 sources / $75,819" can be accounted for
  line by line.
- **Funding origins.** A third tab follows the money past the committee-to-committee
  transfers to whoever originated it, pro-rata across every hop, and exports too. The
  export carries a `share_of` column naming the denominator on every row and a
  `counts_toward_total` flag, because the report is not a table: national pools'
  funders are quoted as shares *of the pool*, and for Keep Florida Great they sum to
  $32.2M against a $400K committee. Summing the amount column blind is the obvious
  mistake to make once the numbers leave the screen, so the file says which rows belong
  in the total and which are context.
- **Election cycle filter.** Current, previous, or all. Rollups are stored per
  cycle, so this narrows an index range rather than filtering after the fact —
  and tile totals, the ledger and the funding trace all follow it, so a filtered
  graph never shows one cycle's edges under another cycle's numbers.
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

The database starts empty. The fastest way to a useful graph is a whole state cycle —
every committee and every candidate, an hour or so unattended:

```bash
docker compose run --rm cli ingest cycle 20261103-GEN
```

Then add whichever counties you care about:

```bash
docker compose run --rm cli ingest county stjohns
```

If you only want one neighbourhood rather than the whole state, seed on a name and grow
outward instead. This is much smaller, and useful when you know what you are looking for:

```bash
docker compose run --rm cli ingest committee "Florida Chamber" --election=20261103-GEN
```

```bash
docker compose run --rm cli ingest expand 3
```

`ingest registry` sweeps the ~7,600 registered committees by name. It is optional — a
cycle sweep already creates every committee that moved money — but it fills in official
spellings, types and active/closed status.

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

A whole cycle can be pulled in one command, because a blank name returns every filer:

```bash
pnpm ingest cycle 20261103-GEN
```

Florida files an entire cycle under its **general-election id** — there is no separate
primary key — so `20261103-GEN` covers the 2026 primary too. The sweep walks date
windows, halving any window that comes back at the row cap, and reports windows it could
not fetch completely rather than quietly returning short.

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
- `rowlimit` is `maxlength=5`, but the CGI parses it as a 16-bit signed integer:
  **32767 is the real ceiling** and 32768 returns `Overflow Error Number = 6`
  instantly, before the query runs.
- Leaving the candidate/committee name blank is *not* an error here (unlike the
  registry lookup) — it returns the whole cycle, which is what makes a full
  sweep affordable.
- A result set larger than the row limit is **truncated silently**: you get
  exactly `rowlimit` rows and no indication more existed. Any window that comes
  back at the cap has to be split and retried, never trusted.
- `search_on` doubles as both the mode selector and the "what would you like to know?"
  choice: `1` contributor list, `2` candidate list, `3` candidate totals, `4` committee
  list, `5` committee totals.
- A blank committee-name search returns `500`; the registry has to be swept by prefix.

The backend is a single SQL Server box behind Cloudflare, so requests are serialized and
rate-limited (`FLDOE_REQUEST_DELAY_MS`, default 1500 ms).

### County Supervisors of Elections — VoterFocus (implemented)

The Division of Elections does **not** hold county filings. County commission, school
board, city commission and special-district races — mosquito control, airport authority,
port and waterway, community development districts — are filed with the 67 county
Supervisors of Elections.

VoterFocus (VR Systems) hosts the portal for a large share of them, and **the county is a
single query parameter**, so one adapter covers all of them:

```bash
pnpm ingest counties              # list supported counties
pnpm ingest county stjohns        # sweep the current cycle
pnpm ingest county stjohns --all  # every cycle the portal offers
pnpm ingest county duval --election=33   # one cycle, by portal id
```

Flags are `--key=value`. A space-separated `--election 33` parses as the boolean true and
would sweep the default cycle instead, so the county command rejects it outright rather
than quietly loading the wrong election.

County portals hold far more history than the state feed exposes, but how much, and how
it is carved up, varies by county:

| | St. Johns | Duval |
|---|---|---|
| Cycles offered | 19, back to 2000 | 22, back to 2015 |
| Filings actually begin | 2004 | 2012 |
| Organized by | one entry per cycle | cycle × filer type |
| Full sweep | ~83,000 txns / $25.6M | ~147,000 txns / $110.6M |

A cycle appearing in the dropdown is not evidence that money data exists for it — the
candidate index outlives the financial reports behind it.

Sweeps run oldest-first so entity resolution meets each recurring donor at its earliest
spelling, and one failing cycle does not abort the rest. A sweep whose election maps to a
known cycle also **back-labels rows loaded before that cycle was recorded**: the row hash
excludes the cycle, so those rows match and would otherwise keep a NULL cycle forever.
Only a missing cycle is filled; one already recorded is never overwritten.

**Odd-year municipal elections have no state cycle.** Jacksonville is a consolidated
city-county, so its mayoral, sheriff and council races run in odd years — and they carry
most of the county's money: 95,844 of Duval's 146,543 rows ($69.6M of $110.6M) sit in the
2015, 2019 and 2023 unitary cycles. `CYCLES` lists only state general elections, so these
rows fall back to date-bucketing and merge into the neighbouring even-year cycle. Nothing
is lost and the filter still works, but the 2023 Jacksonville mayoral race cannot be
selected on its own.

Twenty county slugs are verified, including Miami-Dade, Broward, Palm Beach, Hillsborough,
Orange and Duval. This source is richer than the state feed: ISO dates, expenditures
inline with contributions, and an explicit contributor-type code that tells resolution
when a donor is itself a committee.

Counties not on VoterFocus, and standalone city clerks, still need their own adapters. See
[`src/lib/ingest/README.md`](src/lib/ingest/README.md).

### IRS Form 8872 — national 527s (implemented, targeted)

Some of the largest money entering Florida races never appears in Florida disclosure at
all. The Republican State Leadership Committee sent **$3.5M into six Florida committees**
across 2025–26 while filing nothing with the state: it is a 527, and its own funding is
disclosed to the IRS on Form 8872.

```bash
pnpm ingest irs rslc --from=2025-01-01 --min=10000
```

This is deliberately per-organisation rather than a bulk import, and such an organisation
is marked an **injection point**. A trace stops there and names it instead of continuing
through it. That is a judgement call worth stating plainly: the pool's funders are known,
but no filing says what share of a nationally-raised pool reached Florida, so attributing
its Florida spending pro-rata across its donors would produce estimates that look exactly
like observed transfers while resting on an assumption the data cannot support.

What you get instead is the honest shape: *this $51,429 reached First Coast Leadership
through the RSLC, whose own money is 38% unitemized, 2.3% THE FUND, 2.1% U.S. Chamber of
Commerce, 1.9% Altria…*

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
| `pnpm ingest cycle <electionId>` | Sweep a whole state cycle — every committee and candidate. |
| `pnpm ingest irs <org>` | A national 527's funders, from IRS Form 8872. |
| `pnpm ingest registry` | Sweep the state committee registry A–Z (~7,600 committees). |
| `pnpm ingest counties` | List supported VoterFocus counties. |
| `pnpm ingest county <slug>` | Sweep every candidate and committee in a county. |
| `pnpm ingest committee "<name>"` | Contributions *into* matching committees. |
| `pnpm ingest contributor "<name>"` | Contributions *out of* a contributor. |
| `pnpm ingest candidate "<last>"` | Contributions into a candidate. |
| `pnpm ingest spending "<name>"` | Expenditures *out of* a state committee (add `--candidate` for a candidate). |
| `pnpm ingest spending-cycle <electionId>` | Sweep a whole cycle's expenditures. |
| `pnpm ingest expand <rounds>` | Grow the frontier outward automatically. |
| `pnpm ingest rebuild` | Recompute all rollups and totals. |
| `pnpm ingest purge <source-key>` | Drop everything one source contributed, to re-ingest it cleanly. |
| `pnpm trace "<name>"` | Follow money through conduits to its original sources. |
| `pnpm probe:fldoe` | Live smoke test of the scraping contract, no DB needed. |

Common flags: `--election=20241105-GEN`, `--limit=2000`, `--min=1000`, `--frontier=12`.

In Docker, the same commands run as `docker compose run --rm cli ingest <args>`.

### The graph spans tiers by itself

Entity resolution matches on name and deliberately ignores jurisdiction, so a committee
active at both levels collapses to a single node. The Republican Party of Florida's $6,000
to the St. Johns County Republican Executive Committee links a $13M state committee to a
county school board race with no special handling — a crawl walks straight through.

## Caveats

- Coverage is **Florida**: state-level everywhere, county-level wherever VoterFocus is the
  vendor. Standalone city clerks are not covered.
- Data is only as complete as what you have ingested; the crawler cannot show an edge it
  has never fetched.
- **The cycle filter defaults to the current election, not to everything.** With more
  than one cycle loaded, an unfiltered graph answers "who has *ever* funded this", which
  is rarely the question. Switch to *All* deliberately.
- A county sweep is scoped to one election, so its rows carry that cycle explicitly.
  Rows from any source that lack one — IRS 8872 filings, and odd-year municipal elections
  with no matching general — fall back to the cycle their date lands in. That is an
  approximation at the boundaries, but excluding them from every filter would make those
  races vanish from a filtered graph, which is worse.
- **State expenditures are loaded for 2024 and 2026 only.** Earlier cycles have none, so
  a committee active before 2023 will show money arriving and never leaving. Sweep another
  cycle with `pnpm ingest spending-cycle <electionId> --from=… --to=…`.
- **Committee-to-committee transfers are stored once, from the recipient's filing.** Both
  parties report the same money — the payer as an expenditure, the recipient as a
  contribution — and the ingest drops the payer's copy. A committee's expenditure ledger
  is therefore its *vendor* spending; its transfers to other committees appear as
  contributions on the receiving side. Self-loops are exempt, since a candidate
  reimbursing their own campaign genuinely files both halves.
- **Generic local-office names are scoped to the county that filed them.** Every county
  has a "Republican Executive Committee" and a "Supervisor of Elections", and counties
  file under exactly those bare names, so left alone they collapse into one node — or onto
  whichever county does spell itself out. `isGenericLocalOffice` detects a name that gives
  an office but no place, and such names resolve within their county rather than
  statewide. Names that do say which county ("St. Johns County Republican Executive
  Committee") are untouched and stay a single node across levels, which is what lets a
  committee giving at both state and county level remain one entity.
- **Duval is not yet fixed.** Its bare "Republican Executive Committee" rows still sit on
  the Gadsden node — $5.7M in and $6.5M out, against $5,000 that is genuinely Gadsden's.
  Unlike St. Johns, Duval *does* have a state registry entry to map onto.
- Below-threshold aliases are stored for review and must never be read back as answers.
  Doing so is what merged three counties' committees: "Republican Executive Committee"
  scored 0.809 against Gadsden's — under the 0.88 needed to link — was filed as a
  suggestion, then consumed as the answer on every later lookup. Alias lookup now requires
  `AUTO_LINK_THRESHOLD`.
- Re-sweeping an already-loaded cycle can leave orphan nodes: resolution creates an entity
  before the insert is attempted, and a row that dedupes on its hash leaves that entity
  with nothing attached. Harmless in the graph, since they have no edges, but they show up
  in search as zero-dollar results. Delete county-sourced entities with no transactions
  after a re-sweep. The ~4,500 state-sourced orphans are different and should be kept —
  they are the committee registry, which is what resolution matches against.
- A cycle sweep reports any window it could not fetch completely rather than returning
  short silently. Quarter-end filing dates are where this bites: they can exceed the
  service's row cap within a single day, and are recovered by subdividing on contributor
  name and amount.
- **Truncation is measured in lines delivered, not rows parsed.** The exports drop a
  variable number of lines to malformed content — 3 in one response, 273 in another — so a
  reply cut off at exactly the 32,767-row cap can yield far fewer usable rows and look
  like a short, and therefore final, window. A sweep that makes this mistake stops early
  and reports success. This cost real data before it was fixed: the 2026 contribution
  cycle was missing 28,839 rows, a third of the final month and all of the most recent
  day, while reporting complete. The 2024 cycle, checked the same way, was intact across
  all 1.49M rows. Trust a sweep's own summary only as far as a re-fetch confirms it —
  compare row hashes from the live feed against the database, and expect deliberate
  absences from the mirror guard and the cycle-end cutoff.
- **An audit against a live source measures elapsed time as well as loss.** Re-fetching
  the counties and diffing row hashes reported 1,915 rows the database did not have, which
  looked like an ingestion fault — party executive committees in both counties stopped
  dead on 2026-03-31, the same date, independently. They had not. The morning sweep took
  every row the portal held (250 of 250 on one committee, 148 of 148 on another); the
  committees filed their April-onward reports that afternoon, against a shared deadline,
  and the audit ran after. Re-sweeping recovered 1,914 rows — the audit's arithmetic was
  right to within one row, its framing was not. For counties, whose filings arrive in
  periodic batches, sweep and audit have to bracket the same moment or the diff is mostly
  a clock. The state feed does not have this problem in the same way: a third of a month
  vanishing at a hard cutoff cannot be filing lag.
- Postgres runs with `shm_size: 1gb`. Docker's 64 MB default is too small for the parallel
  plans the trace queries produce, and the failure is opaque: "could not resize shared
  memory segment … No space left on device" (SQLSTATE 53100), which reads like a full disk
  rather than a container limit.
- Entity resolution is good, not perfect. `FLORIDA CHAMBER PAC` and `Florida Chamber of
  Commerce PAC` are almost certainly the same organization but score 0.767 and remain
  separate pending review.
- **The canvas is a filtered slice, the panel is the whole record.** A crawl applies a
  link mode, a per-node cap and a node ceiling, so the graph deliberately shows a subset.
  Use the detail panel's ledger when you need completeness — it queries the database
  directly and ignores the crawl.
- A candidate who funds their own campaign resolves onto their own node, producing a
  self-loop. Those are shown and labelled `self`, but excluded from committee-to-committee
  "direct" links, since self-funding is not a link between two organizations.
- Amounts are as-reported. In-kind contributions are included and flagged, not netted out.

## Licence

Not yet chosen. The underlying campaign finance records are Florida public records.
