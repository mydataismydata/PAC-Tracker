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

export interface FetchOptions {
  /** e.g. '20241105-GEN', or 'All'. */
  election?: string;
  rowLimit?: number;
  dateFrom?: string;
  dateTo?: string;
  minAmount?: number;
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
    clname: '',
    namesearch: NAME_MATCH.containing,
    ccity: '',
    cstate: '',
    czipcode: '',
    coccupation: '',
    cdollar_minimum: opts.minAmount != null ? String(opts.minAmount) : '',
    cdollar_maximum: '',
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
