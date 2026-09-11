/**
 * Find one real donor that the graph is holding as two nodes.
 *
 * The resolver asks whether two names look alike. This asks whether two nodes
 * move money in lockstep, which catches the pairs whose names do not look alike
 * at all.
 *
 * A single transfer that both sides report lands as two rows: the payer files
 * an expenditure, the recipient files a contribution, and the two rows carry
 * the same recipient, the same date and the same amount. `collapseMirrors`
 * folds that pair when both spellings resolve to one node. When they do not,
 * the money is counted twice and a phantom donor sits beside the real one.
 *
 * CFG Action Florida and CLUB FOR GROWTH ACTION FLORIDA were exactly this: four
 * transfers to Friends of Byron Donalds PAC, $3,750,000, every dollar recorded
 * twice, and the names far enough apart that the 0.88 alias gate never joined
 * them.
 *
 * The report comes in three parts. The first two pivot on the donor: two nodes
 * paying the same recipient on the same day for the same amount. What a
 * coincidence means there depends on which way the two rows face.
 *
 *   Counted twice   The two rows face opposite ways — one expenditure against
 *                   one contribution. That is one transfer reported from both
 *                   ends. Merging the pair deletes money that was never given.
 *
 *   In lockstep     Both rows face the same way. The money is real and merging
 *                   will not change any total. The pair is still worth reading:
 *                   sometimes it is one donor filed under two spellings, and
 *                   sometimes it is two affiliated donors who always give
 *                   together. Only a human can tell those apart.
 *
 * The third part pivots on the recipient instead, and catches what the first
 * two cannot see at all.
 *
 *   Split filings   One payer, one amount, days apart, an expenditure against a
 *                   contribution — and the two rows land on *different*
 *                   recipient nodes. The payer named the account one way and
 *                   the recipient named it another, so resolution built two
 *                   nodes and `collapseMirrors`, which needs one pair of nodes
 *                   to work on, never saw a pair at all.
 *
 * JAX Good Government gave Lindsey Brock $1,000 on 2023-04-06 by the state's
 * expenditure file and $1,000 on 2023-04-11 by Duval's contribution file. One
 * landed on "Lindsey Brock Campaign", the other on "BROCK LINDSEY". Same money,
 * two nodes, counted twice. The two spellings score 0.80 against each other —
 * blocking keys agree, word order and the word "campaign" do not — and the
 * auto-link gate is 0.88, so they were never joined.
 *
 * That half looks past an exact date on purpose. A payer and a recipient book
 * the same transfer days apart as a matter of course, so it uses the same
 * asymmetric window `collapseMirrors` does.
 *
 * Two committees can register under one name, and Florida lets them. When both
 * nodes in a pair carry their own account number the report says so, because
 * the fix there is to move the misfiled rows to the right node rather than to
 * merge two committees that were never one.
 *
 * Nothing here is applied. Confirm a pair, write a merge into
 * corrections/corrections.jsonl, and run `pnpm corrections --apply`.
 *
 * Usage:
 *   pnpm dupes                     # both halves, ranked
 *   pnpm dupes --min=250           # widen the net (default 1000)
 *   pnpm dupes --limit=60
 *   pnpm dupes --lockstep          # only the same-direction half
 *   pnpm dupes --split             # only the split-filings half
 *   pnpm dupes --split-min=1000    # that half's own floor (default 100)
 *   pnpm dupes --jsonl             # merge ops for whichever halves are shown
 */

import { sql } from 'drizzle-orm';
import { db, client } from '../src/db';
import { significantTokens, tokenOverlap, trigramSimilarity } from '../src/lib/normalize';

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

/** Below this a coincidence is a fundraiser, not a fingerprint. */
const MIN_AMOUNT = flag('min', 1000);
/**
 * Ignore a (recipient, date, amount) bucket once this many donors are in it.
 * Fifty people writing $1,000 checks at one dinner says nothing about any two
 * of them, and the work grows with the square of the bucket.
 */
const MAX_DONORS = flag('max-donors', 8);
const LIMIT = flag('limit', 30);
/** Below this the pair is a coincidence, not a claim. */
const FLOOR = flag('floor', 0.6);
const AS_JSONL = args.includes('--jsonl');
const ONLY_LOCKSTEP = args.includes('--lockstep');
const ONLY_SPLIT = args.includes('--split');

/**
 * How far apart a payer and a recipient may date the same transfer.
 *
 * Lifted from `MIRROR_WINDOW` in the ingest pipeline, and asymmetric for the
 * reason measured there: a recipient booking the payer's check may be dated
 * well after it, the payer only a little after the recipient.
 */
const RECIPIENT_LAG = flag('recipient-lag', 60);
const PAYER_LAG = flag('payer-lag', 14);

/** Below this two recipient names are a coincidence, not two spellings of one. */
const SPLIT_NAME_FLOOR = flag('split-name', 0.55);

/**
 * The split half's own floor, and far lower than the donor half's.
 *
 * There, a low amount is noise: fifty people write $500 checks at one dinner
 * and none of it says anything about any two of them. Here the pair has to
 * agree on a name before it is reported at all, so a small transfer is as good
 * evidence as a large one — and small is where this bug lives. Every JAX Good
 * Government payment to Lindsey Brock but one was $500, and a $1,000 floor saw
 * a single pair where there were twenty-five.
 *
 * It costs almost nothing to look: dropping the floor from $1,000 to $100
 * takes the scan from one second to three.
 */
const SPLIT_MIN_AMOUNT = flag('split-min', 100);

interface PairRow {
  e1: string;
  e2: string;
  name1: string;
  name2: string;
  kind1: string;
  kind2: string;
  given1: string;
  given2: string;
  events: number;
  recipients: number;
  dollars: string;
  mirrored: number;
  recipientIds: string[];
  into?: string[];
  events1: number;
  events2: number;
  acct1: string | null;
  acct2: string | null;
}

type Scored = PairRow & { coverage: number; name: number; score: number; mirror: number };

/**
 * One transfer that landed on two different recipient nodes.
 *
 * `paid` is where the payer's expenditure went; `got` is where the recipient's
 * own contribution landed. They should be the same node and are not.
 */
interface SplitRow {
  paid: string;
  got: string;
  paidName: string;
  gotName: string;
  paidKind: string;
  gotKind: string;
  paidAcct: string | null;
  gotAcct: string | null;
  paidTotal: string;
  gotTotal: string;
  coincidences: number;
  payers: number;
  dollars: string;
  crossSource: boolean;
}

type ScoredSplit = SplitRow & { name: number; score: number };

async function main() {
  if (ONLY_SPLIT) {
    await reportSplits();
    await client.end();
    return;
  }

  console.log(
    `Scanning transfers of $${MIN_AMOUNT.toLocaleString()} and up, ignoring any date ` +
      `where more than ${MAX_DONORS} donors gave a recipient the same amount…\n`,
  );

  const rows = await pairs();
  console.log(`${rows.length.toLocaleString()} donor pairs hit the same recipient on the ` +
    `same day for the same amount.\n`);

  const scored: Scored[] = rows.map((r) => {
    const coverage = Math.min(r.events1, r.events2) === 0 ? 0 : r.events / Math.min(r.events1, r.events2);
    const name = nameScore(r.name1, r.name2);
    const mirror = r.events === 0 ? 0 : r.mirrored / r.events;
    return { ...r, coverage, name, mirror, score: confidence(r, coverage, name) };
  });

  const worth = scored.filter((s) => s.score >= FLOOR);
  const twice = worth.filter((s) => s.mirror >= 0.5).sort(byDollars);
  const lockstep = worth.filter((s) => s.mirror < 0.5).sort(byScore);

  // A pair holding two account numbers is two committees. Never offer a merge.
  const mergeable = (s: Scored) => !(s.acct1 && s.acct2 && s.acct1 !== s.acct2);

  if (AS_JSONL) {
    for (const s of twice.filter(mergeable).slice(0, LIMIT)) console.log(mergeOp(s));
    await reportSplits();
    await client.end();
    return;
  }

  const shown = [...twice.slice(0, LIMIT), ...lockstep.slice(0, LIMIT)];
  const names = await recipientNames(shown.flatMap((s) => s.recipientIds ?? []));
  for (const s of shown) s.into = (s.recipientIds ?? []).map((id) => names.get(id) ?? id);

  if (!ONLY_LOCKSTEP) {
    const collide = twice.filter((s) => !mergeable(s));
    const sum = (xs: Scored[]) => money(xs.reduce((a, b) => a + Number(b.dollars), 0));
    console.log(
      `COUNTED TWICE — ${twice.length} pairs, $${sum(twice)} recorded on both sides.`,
    );
    console.log(
      `  ${twice.length - collide.length} to merge ($${sum(twice.filter(mergeable))}); ` +
        `${collide.length} are two registered committees sharing a name ` +
        `($${sum(collide)}), where the rows need repointing instead.\n`,
    );
    for (const s of twice.slice(0, LIMIT)) show(s, `$${money(s.dollars)} doubled`);
    if (twice.length > LIMIT) console.log(`  … ${twice.length - LIMIT} more\n`);
  }

  console.log(
    `IN LOCKSTEP — ${lockstep.length} pairs giving the same way on the same days. ` +
      `No money at stake; some are one donor, some are two that travel together.\n`,
  );
  for (const s of lockstep.slice(0, LIMIT)) show(s, `$${money(s.dollars)} in step`);
  if (lockstep.length > LIMIT) console.log(`  … ${lockstep.length - LIMIT} more\n`);

  await reportSplits();

  console.log('Confirm a pair, then add a merge to corrections/corrections.jsonl.');
  console.log('`pnpm dupes --jsonl` writes the merge ops in that format.');

  await client.end();
}

/**
 * The half that pivots on the recipient: one transfer, two recipient nodes.
 *
 * Printed after the others because it is the newest and the least certain per
 * row — two committees really can be named alike — but it is also where the
 * biggest single sums are, so it is never hidden behind a flag.
 */
async function reportSplits(): Promise<void> {
  const rows = await splits();
  const scored: ScoredSplit[] = rows
    .map((r) => {
      const name = nameScore(r.paidName, r.gotName);
      return { ...r, name, score: splitConfidence(r, name) };
    })
    .filter((s) => s.name >= SPLIT_NAME_FLOOR)
    .sort((a, b) => Number(b.dollars) - Number(a.dollars));

  const mergeable = (s: ScoredSplit) =>
    !(s.paidAcct && s.gotAcct && s.paidAcct !== s.gotAcct);

  if (AS_JSONL) {
    for (const s of scored.filter(mergeable).slice(0, LIMIT)) console.log(splitMergeOp(s));
    return;
  }

  const sum = (xs: ScoredSplit[]) => money(xs.reduce((a, b) => a + Number(b.dollars), 0));
  const collide = scored.filter((s) => !mergeable(s));
  console.log(
    `SPLIT FILINGS — ${scored.length} pairs where one transfer landed on two nodes, ` +
      `$${sum(scored)} counted twice.`,
  );
  console.log(
    `  ${scored.length - collide.length} to merge ($${sum(scored.filter(mergeable))}); ` +
      `${collide.length} are two registered committees ($${sum(collide)}), ` +
      `where the rows need repointing instead.\n`,
  );

  for (const s of scored.slice(0, LIMIT)) {
    const conf = s.score >= 0.8 ? 'almost certain' : s.score >= 0.7 ? 'likely' : 'possible';
    console.log(`  ${conf.padEnd(14)} $${money(s.dollars)} doubled`);
    console.log(`    payer filed to   ${s.paidName}  [${s.paidKind}, holds $${money(s.paidTotal)}]`);
    console.log(`    recipient filed  ${s.gotName}  [${s.gotKind}, holds $${money(s.gotTotal)}]`);
    console.log(
      `    ${s.coincidences} transfer(s) from ${s.payers} payer(s); name ${s.name.toFixed(2)}` +
        (s.crossSource ? '; the two filings came from different feeds' : ''),
    );
    if (!mergeable(s)) {
      console.log(
        `    !! both are registered: accounts ${s.paidAcct} and ${s.gotAcct}. Two real ` +
          `committees — repoint the rows, do not merge.`,
      );
    }
    console.log('');
  }
  if (scored.length > LIMIT) console.log(`  … ${scored.length - LIMIT} more\n`);
}

/**
 * Spelling carries most of the weight here, because the money cannot.
 *
 * In the donor-pivot halves two nodes moving in lockstep is itself the
 * evidence. Here the two rows face opposite ways by construction, so the shape
 * proves only that somebody was paid — the claim that these are one account
 * rests on the names, on how often it happens, and on how many unrelated payers
 * filed it the same way. Two feeds disagreeing about the spelling is a further
 * point in favour: it is the signature of the state and a county describing one
 * account.
 */
function splitConfidence(r: SplitRow, name: number): number {
  const repeat = Math.min(r.coincidences / 4, 1);
  const breadth = Math.min(r.payers / 3, 1);
  const corroborated = r.crossSource ? 0.1 : 0;
  return Math.min(1, 0.45 * name + 0.25 * repeat + 0.2 * breadth + corroborated);
}

/**
 * The recipient's own filing wins, as everywhere else in the pipeline.
 *
 * A committee describing the money it received is a better authority on its own
 * name than the payer writing a check to it.
 */
function splitMergeOp(s: ScoredSplit): string {
  return JSON.stringify({
    op: 'merge',
    keep: { id: s.got, name: s.gotName },
    lose: [{ id: s.paid, name: s.paidName }],
    date: new Date().toISOString().slice(0, 10),
    note:
      `${s.coincidences} transfer(s) from ${s.payers} payer(s) filed by the payer as an ` +
      `expenditure to "${s.paidName}" and by the recipient as a contribution to ` +
      `"${s.gotName}", same amounts within the mirror window; $${money(s.dollars)} counted twice.`,
  });
}

/** Display names for the sample recipients, in one round trip. */
async function recipientNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT id, name FROM entities
    WHERE id IN (${sql.join(unique.map((i) => sql`${i}::uuid`), sql`, `)})
  `)) as unknown as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

const byDollars = (a: Scored, b: Scored) => Number(b.dollars) - Number(a.dollars);
const byScore = (a: Scored, b: Scored) => b.score - a.score || Number(b.dollars) - Number(a.dollars);

function show(s: Scored, headline: string) {
  const conf = s.score >= 0.8 ? 'almost certain' : s.score >= 0.7 ? 'likely' : 'possible';
  console.log(`  ${conf.padEnd(14)} ${headline}`);
  console.log(`    ${s.name1}  [${s.kind1}, gave $${money(s.given1)}]`);
  console.log(`    ${s.name2}  [${s.kind2}, gave $${money(s.given2)}]`);
  console.log(
    `    ${s.events} coincidence(s) across ${s.recipients} recipient(s); ` +
      `${s.mirrored} mirrored; covers ${(s.coverage * 100).toFixed(0)}% of the quieter node ` +
      `(${s.events1} vs ${s.events2} transfers); name ${s.name.toFixed(2)}`,
  );
  if (s.acct1 && s.acct2 && s.acct1 !== s.acct2) {
    console.log(
      `    !! both are registered: accounts ${s.acct1} and ${s.acct2}. Two real ` +
        `committees sharing a name — repoint the rows, do not merge.`,
    );
  }
  console.log(`    into: ${(s.into ?? []).join(' · ')}\n`);
}

/**
 * How alike two filed names are, by whichever measure sees the most.
 *
 * A single shared token is capped, because "FARMS" is not evidence that Bedner
 * Farms and R&A Farms are one company.
 */
function nameScore(a: string, b: string): number {
  const best = Math.max(
    trigramSimilarity(a.toUpperCase(), b.toUpperCase()),
    tokenOverlap(a, b),
    acronymOverlap(a, b),
  );
  const smallest = Math.min(significantTokens(a).size, significantTokens(b).size);
  return smallest <= 1 ? Math.min(best, 0.5) : best;
}

/**
 * How much of one name is the other's initials.
 *
 * "CFG Action Florida" against "Club for Growth Action Florida": CFG stands for
 * a run of words in the second name, and what is left over matches. Neither
 * trigram nor token scoring sees that, which is why the pair cleared neither
 * the alias gate nor the name-based duplicate scan.
 */
function acronymOverlap(a: string, b: string): number {
  return Math.max(oneWay(a, b), oneWay(b, a));
}

function oneWay(short: string, long: string): number {
  const st = [...significantTokens(short)];
  const lt = long.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  for (const tok of st) {
    if (tok.length < 2 || tok.length > 6) continue;
    for (let start = 0; start < lt.length; start++) {
      for (let end = start + 2; end <= Math.min(lt.length, start + tok.length + 1); end++) {
        if (lt.slice(start, end).map((w) => w[0]).join('') !== tok) continue;
        const restShort = st.filter((t) => t !== tok).join(' ');
        const restLong = lt.slice(0, start).concat(lt.slice(end)).join(' ');
        if (!restShort || !restLong) return 0.7;
        return 0.6 + 0.4 * tokenOverlap(restShort, restLong);
      }
    }
  }
  return 0;
}

/**
 * Coincidence carries most of the weight, spelling the rest.
 *
 * Four unequal signals. How much of the quieter node's life is spent shadowing
 * the louder one, how often the two coincide, how many different recipients the
 * coincidences reach, and how close the names are. Breadth matters on its own:
 * twenty matches into twenty campaigns is a much stronger claim than twenty
 * into one.
 *
 * One coincidence between two names that look nothing alike is the noise this
 * scan produces most of, so it is cut rather than ranked low.
 */
function confidence(r: PairRow, coverage: number, name: number): number {
  const quieter = Math.min(r.events1, r.events2);
  // Two nodes that each move money once, on one day, for one amount, have told
  // us nothing about each other.
  const lonely = quieter < 2 ? 0 : coverage;
  const repeat = Math.min(r.events / 4, 1);
  const breadth = Math.min(r.recipients / 3, 1);
  const score = 0.25 * lonely + 0.25 * repeat + 0.2 * breadth + 0.3 * name;
  return r.events === 1 && name < 0.75 ? score * 0.4 : Math.min(1, score);
}

/** The louder node keeps its identity; the reviewer should still check. */
function mergeOp(s: Scored): string {
  const first = Number(s.given1) >= Number(s.given2);
  const keep = first ? { id: s.e1, name: s.name1 } : { id: s.e2, name: s.name2 };
  const lose = first ? { id: s.e2, name: s.name2 } : { id: s.e1, name: s.name1 };
  return JSON.stringify({
    op: 'merge',
    keep,
    lose: [lose],
    date: new Date().toISOString().slice(0, 10),
    note:
      `${s.events} transfer(s) to ${s.recipients} recipient(s) appear on both sides of the ` +
      `ledger under both names, same dates and same amounts; $${money(s.dollars)} counted twice.`,
  });
}

function money(v: string | number): string {
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Staged on purpose. Written as one statement the planner collapses the chain
 * and the scan runs past ten minutes; built step by step, with an index on the
 * candidate rows, it finishes in about four seconds.
 */
async function pairs(): Promise<PairRow[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      CREATE TEMP TABLE bucket ON COMMIT DROP AS
      SELECT to_entity_id, txn_date, amount
      FROM transactions
      WHERE to_entity_id IS NOT NULL AND from_entity_id IS NOT NULL AND txn_date IS NOT NULL
        AND amount >= ${MIN_AMOUNT}
      GROUP BY 1, 2, 3
      HAVING count(DISTINCT from_entity_id) BETWEEN 2 AND ${MAX_DONORS}
    `);

    // One row per node per bucket. A node can file the same transfer twice, so
    // collapse before counting. Direction is kept because an expenditure facing
    // a contribution is the signature of one transfer reported from both ends.
    await tx.execute(sql`
      CREATE TEMP TABLE hit ON COMMIT DROP AS
      SELECT DISTINCT t.from_entity_id, t.to_entity_id, t.txn_date, t.amount, t.direction
      FROM transactions t
      JOIN bucket b
        ON b.to_entity_id = t.to_entity_id AND b.txn_date = t.txn_date AND b.amount = t.amount
      WHERE t.from_entity_id IS NOT NULL
    `);
    await tx.execute(sql`CREATE INDEX ON hit (to_entity_id, txn_date, amount)`);

    await tx.execute(sql`
      CREATE TEMP TABLE paired ON COMMIT DROP AS
      WITH coincidence AS (
        SELECT a.from_entity_id AS e1, b.from_entity_id AS e2,
               a.to_entity_id, a.txn_date, a.amount,
               bool_or(a.direction <> b.direction) AS mirrored
        FROM hit a
        JOIN hit b
          ON b.to_entity_id = a.to_entity_id AND b.txn_date = a.txn_date
         AND b.amount = a.amount AND b.from_entity_id > a.from_entity_id
        GROUP BY 1, 2, 3, 4, 5
      )
      SELECT e1, e2,
             count(*)::int AS events,
             count(DISTINCT to_entity_id)::int AS recipients,
             sum(amount) AS dollars,
             count(*) FILTER (WHERE mirrored)::int AS mirrored,
             (array_agg(DISTINCT to_entity_id))[1:3] AS recipient_ids
      FROM coincidence
      GROUP BY 1, 2
    `);

    // How many distinct transfers each node makes in all, at the same floor. A
    // node whose every transfer is shadowed has no independent life, which is
    // what a phantom looks like from the inside.
    await tx.execute(sql`
      CREATE TEMP TABLE activity ON COMMIT DROP AS
      SELECT d.from_entity_id AS id, count(*)::int AS events
      FROM (
        SELECT DISTINCT t.from_entity_id, t.to_entity_id, t.txn_date, t.amount
        FROM transactions t
        WHERE t.from_entity_id IN (SELECT e1 FROM paired UNION SELECT e2 FROM paired)
          AND t.to_entity_id IS NOT NULL AND t.txn_date IS NOT NULL AND t.amount >= ${MIN_AMOUNT}
      ) d
      GROUP BY 1
    `);

    return (await tx.execute(sql`
      SELECT p.e1, p.e2,
             x.name AS "name1", y.name AS "name2",
             x.kind::text AS "kind1", y.kind::text AS "kind2",
             x.total_given AS "given1", y.total_given AS "given2",
             p.events, p.recipients, p.dollars, p.mirrored,
             ax.events AS "events1", ay.events AS "events2",
             (SELECT r.external_id FROM committee_registrations r
               WHERE r.entity_id = p.e1 AND r.is_current LIMIT 1) AS "acct1",
             (SELECT r.external_id FROM committee_registrations r
               WHERE r.entity_id = p.e2 AND r.is_current LIMIT 1) AS "acct2",
             p.recipient_ids AS "recipientIds"
      FROM paired p
      JOIN entities x ON x.id = p.e1
      JOIN entities y ON y.id = p.e2
      JOIN activity ax ON ax.id = p.e1
      JOIN activity ay ON ay.id = p.e2
      ORDER BY p.dollars DESC
    `)) as unknown as PairRow[];
  });
}

/**
 * Every transfer whose two filings landed on two different recipient nodes.
 *
 * Staged like `pairs`, and for the same reason. The bucket is narrow on
 * purpose: a (payer, amount) that carries both directions and reaches more
 * than one node is the only shape worth pairing, and finding it is a single
 * grouped scan. Everything after that works on 17,000 rows rather than six
 * million.
 */
async function splits(): Promise<SplitRow[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      CREATE TEMP TABLE sbucket ON COMMIT DROP AS
      SELECT from_entity_id, amount
      FROM transactions
      WHERE from_entity_id IS NOT NULL AND to_entity_id IS NOT NULL AND txn_date IS NOT NULL
        AND amount >= ${SPLIT_MIN_AMOUNT} AND from_entity_id <> to_entity_id
      GROUP BY 1, 2
      HAVING bool_or(direction = 'expenditure') AND bool_or(direction = 'contribution')
         AND count(DISTINCT to_entity_id) BETWEEN 2 AND ${MAX_DONORS + 4}
    `);
    await tx.execute(sql`CREATE INDEX ON sbucket (from_entity_id, amount)`);

    // One row per node per bucket: a filer that reported the same transfer
    // twice must not count twice toward the coincidence.
    await tx.execute(sql`
      CREATE TEMP TABLE sleg ON COMMIT DROP AS
      SELECT DISTINCT t.from_entity_id, t.to_entity_id, t.amount, t.txn_date,
                      t.direction, t.source_id
      FROM transactions t
      JOIN sbucket b ON b.from_entity_id = t.from_entity_id AND b.amount = t.amount
      WHERE t.txn_date IS NOT NULL AND t.to_entity_id IS NOT NULL
    `);

    await tx.execute(sql`
      CREATE TEMP TABLE ssplit ON COMMIT DROP AS
      SELECT p.to_entity_id AS paid, g.to_entity_id AS got,
             count(*)::int AS coincidences,
             count(DISTINCT p.from_entity_id)::int AS payers,
             sum(p.amount) AS dollars,
             bool_or(p.source_id IS DISTINCT FROM g.source_id) AS cross_source
      FROM sleg p
      JOIN sleg g
        ON g.from_entity_id = p.from_entity_id AND g.amount = p.amount
       AND p.direction = 'expenditure' AND g.direction = 'contribution'
       AND g.txn_date BETWEEN p.txn_date - ${PAYER_LAG}::int AND p.txn_date + ${RECIPIENT_LAG}::int
      WHERE p.to_entity_id <> g.to_entity_id
      GROUP BY 1, 2
    `);

    return (await tx.execute(sql`
      SELECT s.paid, s.got,
             x.name AS "paidName", y.name AS "gotName",
             x.kind::text AS "paidKind", y.kind::text AS "gotKind",
             x.total_received AS "paidTotal", y.total_received AS "gotTotal",
             s.coincidences, s.payers, s.dollars, s.cross_source AS "crossSource",
             (SELECT r.external_id FROM committee_registrations r
               WHERE r.entity_id = s.paid AND r.is_current LIMIT 1) AS "paidAcct",
             (SELECT r.external_id FROM committee_registrations r
               WHERE r.entity_id = s.got AND r.is_current LIMIT 1) AS "gotAcct"
      FROM ssplit s
      JOIN entities x ON x.id = s.paid
      JOIN entities y ON y.id = s.got
      -- Cheap first cut. The real name test runs in TypeScript, which can see
      -- word order and acronyms that trigram similarity alone cannot.
      WHERE similarity(x.normalized_name, y.normalized_name) >= 0.3
         OR x.normalized_name % y.normalized_name
      ORDER BY s.dollars DESC
    `)) as unknown as SplitRow[];
  });
}

main().catch(async (e) => {
  console.error(e);
  await client.end();
  process.exit(1);
});
