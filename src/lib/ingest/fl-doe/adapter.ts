/**
 * Florida Division of Elections source adapter.
 *
 * Scope note: the Division of Elections holds filings for state-level races and
 * every state-registered committee (PAC / CCE / ECO / ECI / IXO / PAP / PTY).
 * County, municipal, school board and special-district candidates file with
 * their county Supervisor of Elections or city clerk instead, so those need
 * separate adapters — see `src/lib/ingest/README.md`.
 *
 * The two directions the graph crawler needs map neatly onto two search modes:
 *   upstream   (who funded X)  -> committee/candidate contribution list
 *   downstream (where X gave)  -> contributor search
 */

import { FlDoeClient, SEARCH_ON, NAME_MATCH, SORT, MAX_ROW_LIMIT } from './client';
import {
  parseContributionTsv,
  parseCommitteeRegistryHtml,
  type RawContributionRow,
  type RegistryCommittee,
} from './parse';

/** Election cycle keys as the DOE labels them. */
export const ELECTION_ALL = 'All';

/**
 * How close to `MAX_ROW_LIMIT` counts as "the CGI truncated us".
 *
 * Parsing drops a few rows per response (repeated headers, footer markup), so
 * a truncated window lands just under the cap rather than exactly on it.
 */
const TRUNCATION_MARGIN = 16;

/** Which universe of recipients a broad sweep covers. */
export type BroadMode = 'committee' | 'candidate';

/**
 * First characters used to partition contributors on an overloaded day.
 *
 * A–Z and 0–9 account for 99.995% of contributor names in the live data; the
 * punctuation entries are the complete set of other leading characters
 * observed, kept so the partition does not silently drop them.
 */
const NAME_PREFIXES = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...['$', '"', ',', '(', '&', '\\', "'"],
];

export interface CycleWindow {
  mode: BroadMode;
  /** ISO yyyy-mm-dd, inclusive. */
  from: string;
  to: string;
  rows: RawContributionRow[];
}

export interface CycleWindowInfo {
  mode: BroadMode;
  from: string;
  to: string;
  rows: number;
  /**
   * `advance` is a full batch with more to come; `ok` is the final short batch.
   * `truncated` means a single day overflowed the cap and rows were lost.
   */
  action: 'ok' | 'advance' | 'truncated' | 'failed';
  error?: string;
}

/** ISO yyyy-mm-dd -> the mm/dd/yyyy the form expects. */
function toUsDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}


export interface FetchOptions {
  /** e.g. '20241105-GEN', or 'All'. */
  election?: string;
  rowLimit?: number;
  dateFrom?: string;
  dateTo?: string;
  minAmount?: number;
  maxAmount?: number;
  /** Restrict to contributors whose name starts with this. */
  contributorPrefix?: string;
  /** Name-match mode; defaults to exact-ish "starts with" to limit fan-out. */
  match?: (typeof NAME_MATCH)[keyof typeof NAME_MATCH];
}

/**
 * Baseline form fields.
 *
 * The CGI expects the *whole* form, not just the fields relevant to the chosen
 * mode; omitting them produces ODBC errors rather than defaults. `csort1` in
 * particular must be non-empty.
 */
function baseForm(opts: FetchOptions): Record<string, string | number> {
  return {
    election: opts.election ?? ELECTION_ALL,
    CanFName: '',
    CanLName: '',
    CanNameSrch: NAME_MATCH.containing,
    office: 'All',
    cdistrict: '',
    cgroup: '',
    party: 'All',
    ComName: '',
    ComNameSrch: NAME_MATCH.containing,
    committee: 'All',
    cfname: '',
    clname: opts.contributorPrefix ?? '',
    namesearch: opts.contributorPrefix ? NAME_MATCH.startsWith : NAME_MATCH.containing,
    ccity: '',
    cstate: '',
    czipcode: '',
    coccupation: '',
    cdollar_minimum: opts.minAmount != null ? String(opts.minAmount) : '',
    cdollar_maximum: opts.maxAmount != null ? String(opts.maxAmount) : '',
    rowlimit: Math.min(opts.rowLimit ?? 5000, MAX_ROW_LIMIT),
    csort1: SORT.amountDesc,
    csort2: SORT.name,
    cdatefrom: opts.dateFrom ?? '',
    cdateto: opts.dateTo ?? '',
    queryformat: 2, // tab-delimited
    Submit: 'Submit',
  };
}

export class FlDoeAdapter {
  readonly sourceKey = 'fl-doe';

  constructor(private readonly client: FlDoeClient = new FlDoeClient()) {}

  /**
   * Money *into* a committee: every reported contribution it received.
   * This is the upstream hop for committee nodes.
   */
  async contributionsToCommittee(
    committeeName: string,
    opts: FetchOptions = {},
  ): Promise<RawContributionRow[]> {
    const text = await this.client.post('contributions', {
      ...baseForm(opts),
      search_on: SEARCH_ON.committeeList,
      ComName: committeeName,
      ComNameSrch: opts.match ?? NAME_MATCH.startsWith,
    });
    return parseContributionTsv(text, { electionCycle: opts.election ?? ELECTION_ALL }).rows;
  }

  /**
   * Money *into* a candidate's campaign account.
   * Florida indexes candidates by last name, so callers pass name parts.
   */
  async contributionsToCandidate(
    lastName: string,
    firstName = '',
    opts: FetchOptions = {},
  ): Promise<RawContributionRow[]> {
    const text = await this.client.post('contributions', {
      ...baseForm(opts),
      search_on: SEARCH_ON.candidateList,
      CanLName: lastName,
      CanFName: firstName,
      CanNameSrch: opts.match ?? NAME_MATCH.startsWith,
    });
    return parseContributionTsv(text, { electionCycle: opts.election ?? ELECTION_ALL }).rows;
  }

  /**
   * Money *out of* an entity: everywhere this name appears as the contributor.
   *
   * This is the downstream hop, and the reason a PAC-to-PAC chain is walkable
   * at all — a committee that donates shows up here as a plain contributor
   * string, which entity resolution then links back to its committee node.
   */
  async contributionsFromContributor(
    contributorName: string,
    opts: FetchOptions = {},
  ): Promise<RawContributionRow[]> {
    const text = await this.client.post('contributions', {
      ...baseForm(opts),
      search_on: SEARCH_ON.contributorList,
      clname: contributorName,
      namesearch: opts.match ?? NAME_MATCH.startsWith,
    });
    return parseContributionTsv(text, { electionCycle: opts.election ?? ELECTION_ALL }).rows;
  }

  /**
   * Every contribution in a cycle, for all committees or all candidates.
   *
   * Leaving the name fields blank makes the CGI return the whole cycle rather
   * than erroring, which is the difference between one sweep and 7,600
   * committee-by-committee lookups.
   */
  private async contributionsInWindow(
    mode: BroadMode,
    from: string,
    to: string,
    opts: FetchOptions,
  ): Promise<RawContributionRow[]> {
    const text = await this.client.post('contributions', {
      ...baseForm({ ...opts, dateFrom: from, dateTo: to, rowLimit: MAX_ROW_LIMIT }),
      search_on: mode === 'committee' ? SEARCH_ON.committeeList : SEARCH_ON.candidateList,
      // Date order keeps a truncated window's loss contiguous and detectable,
      // rather than scattering it across the whole date range.
      csort1: SORT.dateAsc,
    });
    return parseContributionTsv(text, { electionCycle: opts.election ?? ELECTION_ALL }).rows;
  }

  /**
   * Sweep a whole election cycle by walking a date cursor forward.
   *
   * A cycle-wide query exceeds what the CGI will return, and it truncates
   * *silently* — you get exactly `rowlimit` rows and nothing says more existed.
   * The saving grace is that results come back date-ordered, so a truncated
   * response still reports how far it got: everything up to its last date is
   * real, and the next request resumes from there.
   *
   * That makes this a cursor walk rather than a binary search over windows,
   * which matters because every probe costs a multi-megabyte response from a
   * slow origin — splitting blindly would throw away one maximal fetch for
   * each level of recursion.
   *
   * The cursor deliberately resumes *on* the last date seen rather than the day
   * after, since the cut can fall midway through a day. That re-fetches one
   * day per window; those rows dedupe on their hash, whereas skipping them
   * would silently lose whatever sat past the cut.
   */
  async *sweepCycle(
    mode: BroadMode,
    opts: FetchOptions & {
      from: string;
      to: string;
      onWindow?: (info: CycleWindowInfo) => void;
    },
  ): AsyncGenerator<CycleWindow> {
    let cursor = opts.from;

    while (cursor <= opts.to) {
      let rows: RawContributionRow[];
      try {
        rows = await this.contributionsInWindow(mode, toUsDate(cursor), toUsDate(opts.to), opts);
      } catch (err) {
        opts.onWindow?.({
          mode,
          from: cursor,
          to: opts.to,
          rows: 0,
          action: 'failed',
          error: String(err),
        });
        return;
      }

      const truncated = rows.length >= MAX_ROW_LIMIT - TRUNCATION_MARGIN;
      if (!truncated) {
        opts.onWindow?.({ mode, from: cursor, to: opts.to, rows: rows.length, action: 'ok' });
        if (rows.length > 0) yield { mode, from: cursor, to: opts.to, rows };
        return;
      }

      const lastDate = rows.reduce<string | null>(
        (max, r) => (r.date && (max === null || r.date > max) ? r.date : max),
        null,
      );

      // A single day overflowing the cap leaves the date cursor with nowhere to
      // go — quarter-end and year-end filing dates carry a disproportionate
      // share of the cycle. Subdivide that day on the other available axes.
      if (lastDate === null || lastDate <= cursor) {
        yield* this.sweepStuckDay(mode, cursor, opts);
        cursor = addDays(cursor, 1);
        continue;
      }

      opts.onWindow?.({ mode, from: cursor, to: lastDate, rows: rows.length, action: 'advance' });
      yield { mode, from: cursor, to: lastDate, rows };
      cursor = lastDate;
    }
  }

  /**
   * Recover a single day that exceeds the row cap.
   *
   * Contributor-name prefix is the better first cut: it spreads evenly (a
   * single letter takes a 32767-row day down to 2000–6500) whereas amount is
   * lumpy and its shape flips between dates — 2025-03-31 is crowded below $100,
   * 2025-12-31 above $1000. Amount is kept as the inner axis for prefixes that
   * are still too big.
   *
   * The prefix set covers A–Z and 0–9 plus the handful of punctuation
   * characters that actually begin contributor names in this data (29 rows in
   * 536k). It is enumerated rather than derived, so anything outside it would
   * be missed — hence the reconciliation warning the caller reports.
   */
  private async *sweepStuckDay(
    mode: BroadMode,
    date: string,
    opts: FetchOptions & { onWindow?: (info: CycleWindowInfo) => void },
  ): AsyncGenerator<CycleWindow> {
    const us = toUsDate(date);

    for (const prefix of NAME_PREFIXES) {
      let rows: RawContributionRow[];
      try {
        rows = await this.contributionsInWindow(mode, us, us, {
          ...opts,
          contributorPrefix: prefix,
        });
      } catch (err) {
        opts.onWindow?.({
          mode,
          from: date,
          to: date,
          rows: 0,
          action: 'failed',
          error: `prefix "${prefix}": ${String(err)}`,
        });
        continue;
      }

      if (rows.length >= MAX_ROW_LIMIT - TRUNCATION_MARGIN) {
        // Still too big for one prefix: cut it by amount as well.
        yield* this.sweepDayByAmount(mode, date, { ...opts, contributorPrefix: prefix });
        continue;
      }

      if (rows.length > 0) yield { mode, from: date, to: date, rows };
    }
  }

  /**
   * Bisect one day (optionally already narrowed to a contributor prefix) on
   * contribution amount.
   *
   * Amounts are heavy-tailed, so the midpoint is geometric rather than
   * arithmetic — halving the range would spend twenty requests descending from
   * $100M before reaching the crowded end.
   *
   * Bands are inclusive at both ends and deliberately overlap at the midpoint —
   * a gap would drop every contribution landing exactly on it, while the
   * overlap costs nothing, since duplicates collapse on their row hash.
   *
   * This can still fail to converge: thousands of contributions of one exact
   * amount on one date are indivisible on this axis, which is why the caller
   * narrows by contributor first.
   */
  private async *sweepDayByAmount(
    mode: BroadMode,
    date: string,
    opts: FetchOptions & { onWindow?: (info: CycleWindowInfo) => void },
  ): AsyncGenerator<CycleWindow> {
    // Cents, to keep the midpoint exact; the ceiling is above any contribution
    // Florida has ever recorded (the largest to date is $15M).
    const stack: Array<[number, number]> = [[0, 100_000_000_00]];
    const us = toUsDate(date);

    while (stack.length > 0) {
      const [lo, hi] = stack.pop()!;
      let rows: RawContributionRow[];
      try {
        rows = await this.contributionsInWindow(mode, us, us, {
          ...opts,
          minAmount: lo / 100,
          maxAmount: hi / 100,
        });
      } catch (err) {
        opts.onWindow?.({
          mode,
          from: date,
          to: date,
          rows: 0,
          action: 'failed',
          error: `$${lo / 100}–$${hi / 100}: ${String(err)}`,
        });
        continue;
      }

      if (rows.length >= MAX_ROW_LIMIT - TRUNCATION_MARGIN && hi - lo > 1) {
        // Geometric midpoint, clamped so it always lands strictly inside the
        // band — otherwise a band like [0, 1] would keep splitting into itself.
        const mid = Math.min(hi - 1, Math.max(lo + 1, Math.round(Math.sqrt(Math.max(lo, 1) * hi))));
        stack.push([mid, hi], [lo, mid]);
        continue;
      }

      const stuck = rows.length >= MAX_ROW_LIMIT - TRUNCATION_MARGIN;
      opts.onWindow?.({
        mode,
        from: date,
        to: date,
        rows: rows.length,
        action: stuck ? 'truncated' : 'ok',
        error: stuck ? `$${lo / 100}–$${hi / 100} exceeds the row cap` : undefined,
      });
      if (rows.length > 0) yield { mode, from: date, to: date, rows };
    }
  }

  /**
   * Enumerate the committee registry by name prefix.
   *
   * A blank search 500s, so the full registry is assembled by sweeping A–Z and
   * 0–9 with "starts with". Committee names beginning with punctuation are
   * picked up by the separate `containing` passes the caller can add.
   */
  async committeesByPrefix(prefix: string): Promise<RegistryCommittee[]> {
    const html = await this.client.post('committeeLookup', {
      searchtype: 1,
      comName: prefix,
      LkupTypeName: 'L', // starts with
      NameSearchBtn: 'Search by Name',
    });
    return parseCommitteeRegistryHtml(html);
  }

  /** Full registry sweep across the alphabet and digits. */
  async sweepCommitteeRegistry(
    onProgress?: (prefix: string, found: number, total: number) => void,
  ): Promise<RegistryCommittee[]> {
    const prefixes = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
    const seen = new Map<string, RegistryCommittee>();

    for (const p of prefixes) {
      const found = await this.committeesByPrefix(p);
      for (const c of found) {
        // Same name can appear under both an active and a closed registration;
        // prefer the active one for display.
        const existing = seen.get(c.name);
        if (!existing || (existing.status !== 'active' && c.status === 'active')) {
          seen.set(c.name, c);
        }
      }
      onProgress?.(p, found.length, seen.size);
    }
    return [...seen.values()];
  }
}
