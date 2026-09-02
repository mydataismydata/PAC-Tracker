/**
 * Candidate nodes, found by the person's name.
 *
 * A Florida candidate has no separate committee: the campaign account *is*
 * the candidate. The registry writes that node as "Leek, Tom  (REP)(STS)",
 * but a PAC paying it writes "LEEK, TOM", "TOM LEEK CAMPAIGN" or "ALLISON
 * TANT CAMPAIGN FUND", and none of those ever matched the node — 16,798
 * committee expenditures worth $16.4M had landed on look-alike nodes by
 * 2026-09-02, with only 189 on candidates. This index answers "which
 * candidate is this?" for a payee string, telling one person's campaigns
 * apart by the office words in the string and by date.
 *
 * It answers only for payees of committee and party expenditures. The same
 * person's name on the contributor side is the person — a candidate lending
 * their own campaign money, or an incumbent giving to a colleague — and must
 * stay a separate node.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { normalizeName } from '@/lib/normalize';

type Db = PostgresJsDatabase<typeof schema>;

export interface CandidateNode {
  id: string;
  name: string;
  /** Florida's office code from the registry name: STR, STS, CTJ, GOV… Null on county nodes. */
  officeCode: string | null;
  /** Office as county sources report it: "City Council District 7", "Mayor". */
  office: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface CampaignName {
  /** The person's name, normalized, in the order the source wrote it. */
  person: string;
  /** True when a campaign phrase was stripped: "X CAMPAIGN FUND", "X FOR STATE HOUSE". */
  named: boolean;
  /** Office words that came with the name, normalized, when any did. */
  office: string | null;
}

export interface CandidateMatch {
  /** The one node this string names, or null when none or several do. */
  node: CandidateNode | null;
  /** Every node sharing the person's name, before office and date narrowed it. */
  options: CandidateNode[];
  parsed: CampaignName;
  /** The office words name a federal race, which Florida never files: no node can exist. */
  federal: boolean;
}

const REGISTRY_TAGS = /\s*\(([A-Z]{2,4})\)\(([A-Z]{2,4})\)\s*$/;
const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV']);
/** Words in an office phrase that pick a county office by its text. */
const COUNTY_OFFICE_WORDS = new Set([
  'COUNCIL', 'MAYOR', 'SHERIFF', 'SCHOOL', 'COMMISSION', 'COMMISSIONER', 'CLERK', 'SUPERVISOR',
  'APPRAISER', 'COLLECTOR', 'JUDGE', 'ATTORNEY', 'DEFENDER', 'BOARD',
]);
/** How far outside a node's observed span a row may fall and still be its money. */
const SPAN_PAD_MS = 400 * 86_400_000;
/**
 * Words that belong to a race, not a person. A payee written "MATT SUSIN
 * SCHOOL BOARD CAMPAIGN" carries them before the campaign word, so the
 * person's name ends where they begin.
 */
const RACE_WORDS = new Set([
  'STATE', 'HOUSE', 'SENATE', 'REPRESENTATIVE', 'REP', 'SENATOR', 'DISTRICT', 'DIST', 'SEAT', 'GROUP',
  'CITY', 'COUNTY', 'CIRCUIT', 'JUDICIAL', 'MAYOR', 'GOVERNOR', 'JUDGE', 'RE', 'REELECTION', 'ELECTION',
  'CANDIDATE', 'REPUBLICAN', 'DEMOCRAT', 'DEMOCRATIC', 'FL', 'FLORIDA', 'HD', 'SD', 'COUNCIL', 'COMMISSION',
  'COMMISSIONER', 'SHERIFF', 'SCHOOL', 'BOARD', 'CLERK', 'SUPERVISOR', 'APPRAISER', 'COLLECTOR', 'ATTORNEY',
  'DEFENDER', 'PUBLIC', 'CONGRESS', 'CONGRESSIONAL', 'US', 'PRIMARY', 'GENERAL', 'FUND', 'ACCOUNT',
]);
/** Given names as filers shorten them; both directions are tried. */
const NICKNAMES: Record<string, string[]> = {
  MICHAEL: ['MIKE'], MIKE: ['MICHAEL'], JAMES: ['JIM', 'JIMMY'], JIM: ['JAMES'], JIMMY: ['JAMES'],
  ROBERT: ['BOB', 'ROB', 'BOBBY'], BOB: ['ROBERT'], ROB: ['ROBERT'], BOBBY: ['ROBERT'],
  WILLIAM: ['BILL', 'WILL', 'BILLY'], BILL: ['WILLIAM'], WILL: ['WILLIAM'], BILLY: ['WILLIAM'],
  RICHARD: ['RICK', 'DICK', 'RICH'], RICK: ['RICHARD'], DICK: ['RICHARD'], RICH: ['RICHARD'],
  THOMAS: ['TOM', 'TOMMY'], TOM: ['THOMAS'], TOMMY: ['THOMAS'], DANIEL: ['DAN', 'DANNY'], DAN: ['DANIEL'], DANNY: ['DANIEL'],
  CHRISTOPHER: ['CHRIS'], CHRIS: ['CHRISTOPHER', 'CHRISTINE', 'CHRISTINA'], JOSEPH: ['JOE', 'JOEY'], JOE: ['JOSEPH'],
  ANTHONY: ['TONY'], TONY: ['ANTHONY'], MATTHEW: ['MATT'], MATT: ['MATTHEW'], ANDREW: ['ANDY', 'DREW'], ANDY: ['ANDREW'],
  EDWARD: ['ED', 'EDDIE'], ED: ['EDWARD'], EDDIE: ['EDWARD'], NICHOLAS: ['NICK'], NICK: ['NICHOLAS'],
  STEPHEN: ['STEVE'], STEVEN: ['STEVE'], STEVE: ['STEVEN', 'STEPHEN'], KENNETH: ['KEN', 'KENNY'], KEN: ['KENNETH'],
  TIMOTHY: ['TIM'], TIM: ['TIMOTHY'], PATRICK: ['PAT'], PATRICIA: ['PAT', 'PATTY', 'TRISH'], PAT: ['PATRICK', 'PATRICIA'],
  JONATHAN: ['JON'], JON: ['JONATHAN'], JOHN: ['JACK', 'JOHNNY'], JACK: ['JOHN'], DAVID: ['DAVE'], DAVE: ['DAVID'],
  ALEXANDER: ['ALEX'], ALEX: ['ALEXANDER', 'ALEXANDRA'], BENJAMIN: ['BEN'], BEN: ['BENJAMIN'], SAMUEL: ['SAM'], SAM: ['SAMUEL', 'SAMANTHA'],
  ELIZABETH: ['LIZ', 'BETH', 'BETSY'], LIZ: ['ELIZABETH'], BETH: ['ELIZABETH'], KATHERINE: ['KATHY', 'KATE', 'KATIE'], KATHY: ['KATHERINE', 'KATHLEEN'],
  MARGARET: ['MEG', 'PEGGY', 'MAGGIE'], PEGGY: ['MARGARET'], JENNIFER: ['JEN', 'JENNY', 'JENNA'], JEN: ['JENNIFER'],
  KIMBERLY: ['KIM'], KIM: ['KIMBERLY'], DEBORAH: ['DEBBIE', 'DEB'], DEBBIE: ['DEBORAH'], REBECCA: ['BECKY'], BECKY: ['REBECCA'],
  SUSAN: ['SUE'], SUE: ['SUSAN'], JACQUELINE: ['JACKIE'], JACKIE: ['JACQUELINE'], GREGORY: ['GREG'], GREG: ['GREGORY'],
  RANDOLPH: ['RANDY'], RANDALL: ['RANDY'], RANDY: ['RANDOLPH', 'RANDALL'], LAWRENCE: ['LARRY'], LARRY: ['LAWRENCE'],
  DONALD: ['DON'], DON: ['DONALD'], RONALD: ['RON'], RON: ['RONALD'], RAYMOND: ['RAY'], RAY: ['RAYMOND'],
  CHARLES: ['CHUCK', 'CHARLIE'], CHUCK: ['CHARLES'], CHARLIE: ['CHARLES'], FREDERICK: ['FRED'], FRED: ['FREDERICK'],
  JEFFREY: ['JEFF'], JEFF: ['JEFFREY', 'GEOFFREY'], GEOFFREY: ['GEOFF', 'JEFF'], GEOFF: ['GEOFFREY'],
  VICTORIA: ['VICKI', 'VICKY'], VICKI: ['VICTORIA'], VICKY: ['VICTORIA'], PHILIP: ['PHIL'], PHILLIP: ['PHIL'], PHIL: ['PHILIP', 'PHILLIP'],
};

export function officeCodeFromName(name: string): string | null {
  const m = name.match(REGISTRY_TAGS);
  return m ? m[2] : null;
}

const tokens = (s: string): string[] => normalizeName(s).split(' ').filter(Boolean);

/**
 * Every spelling a payer might use for this node's person: "LAST FIRST",
 * "FIRST LAST", with and without middle names and initials.
 */
export function personKeys(name: string): string[] {
  const bare = name.replace(REGISTRY_TAGS, '').trim();
  let last: string[];
  let first: string[];
  if (bare.includes(',')) {
    const [l, f] = bare.split(',', 2);
    last = tokens(l);
    first = tokens(f);
  } else {
    const t = tokens(bare);
    if (t.length < 2) return [];
    last = [t[t.length - 1]];
    first = t.slice(0, -1);
  }
  first = first.filter((x) => !SUFFIXES.has(x));
  if (last.length === 0 || first.length === 0) return [];
  const forms = [first, first.slice(0, 1), first.filter((x) => x.length > 1)];
  const keys = new Set<string>();
  for (const f of forms) {
    if (f.length === 0) continue;
    keys.add([...last, ...f].join(' '));
    keys.add([...f, ...last].join(' '));
  }
  return [...keys].filter((k) => k.length >= 6);
}

/** Pull the person out of a payee string and keep whatever office words came with them. */
export function campaignName(raw: string): CampaignName {
  let s = normalizeName(raw);
  let named = false;
  let office: string | null = null;
  let m = s.match(
    /^(?:THE )?(?:CAMPAIGN (?:FUND|ACCOUNT|COMMITTEE|FUNDS)(?: OF| FOR)?|COMMITTEE TO (?:RE ?)?ELECT|(?:RE ?)?ELECT) (.+)$/,
  );
  if (m) {
    s = m[1];
    named = true;
  }
  m = s.match(/^(.+?) CAMPAIGN(?: (?:FUND|ACCOUNT|COMMITTEE|FUNDS))?(?: (.+))?$/);
  if (m) {
    s = m[1];
    named = true;
    if (m[2]) office = m[2];
  }
  m = s.match(/^(.+?) FOR (.+)$/);
  if (m) {
    s = m[1];
    named = true;
    office = office ? `${office} ${m[2]}` : m[2];
  }
  // Race words riding inside the person's name belong to the office phrase.
  const t = s.split(' ').filter(Boolean);
  const cut = t.findIndex((w, i) => i >= 2 && (RACE_WORDS.has(w) || /\d/.test(w)));
  if (cut > 0) {
    const rest = t.slice(cut).join(' ');
    s = t.slice(0, cut).join(' ');
    office = office ? `${rest} ${office}` : rest;
  }
  return { person: s.trim(), named, office };
}

/** The registry office code an office phrase points at; FEDERAL for races Florida does not file. */
export function officeCodeFromPhrase(phrase: string): string | null {
  const p = ` ${phrase} `;
  if (/ (CONGRESS|CONGRESSIONAL|US SENATE|U S SENATE|PRESIDENT|FEDERAL) /.test(p)) return 'FEDERAL';
  if (/ (REPRESENTATIVE|REP|HOUSE|ASSEMBLY|HD ?\d+) /.test(p) || / HD\d+ /.test(p)) return 'STR';
  if (/ (SENATE|SENATOR|SD ?\d+) /.test(p) || / SD\d+ /.test(p)) return 'STS';
  if (/ PUBLIC DEFENDER /.test(p)) return 'PUB';
  if (/ STATE ATTORNEY /.test(p)) return 'STA';
  if (/ ATTORNEY GENERAL /.test(p)) return 'ATG';
  if (/ (JUDGE|CIRCUIT|JUDICIAL|COUNTY COURT) /.test(p)) return 'CTJ';
  if (/ GOVERNOR /.test(p)) return 'GOV';
  if (/ (CFO|CHIEF FINANCIAL) /.test(p)) return 'CFO';
  if (/ AGRICULTURE /.test(p)) return 'AGR';
  return null;
}

function inSpan(node: CandidateNode, from: number, to: number): boolean {
  if (!node.firstSeen || !node.lastSeen) return true;
  const lo = Date.parse(node.firstSeen) - SPAN_PAD_MS;
  const hi = Date.parse(node.lastSeen) + SPAN_PAD_MS;
  return from <= hi && to >= lo;
}

export class CandidateIndex {
  private byKey = new Map<string, CandidateNode[]>();
  private nodes = new Map<string, CandidateNode>();

  static async load(db: Db): Promise<CandidateIndex> {
    type Row = {
      id: string;
      name: string;
      office: string | null;
      first_seen: string | null;
      last_seen: string | null;
    };
    const rows = await db.execute<Row>(sql`
      SELECT id, name, office, first_seen::text AS first_seen, last_seen::text AS last_seen
        FROM entities WHERE kind = 'candidate'
    `);
    const index = new CandidateIndex();
    for (const r of rows) {
      index.add({
        id: r.id,
        name: r.name,
        officeCode: officeCodeFromName(r.name),
        office: r.office,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
      });
    }
    return index;
  }

  get size(): number {
    return this.nodes.size;
  }

  /** Every normalized spelling the index answers to, for a database-side prefilter. */
  keys(): string[] {
    return [...this.byKey.keys()];
  }

  add(node: CandidateNode): void {
    if (this.nodes.has(node.id)) return;
    this.nodes.set(node.id, node);
    for (const k of personKeys(node.name)) {
      const list = this.byKey.get(k);
      if (list) list.push(node);
      else this.byKey.set(k, [node]);
    }
  }

  /** Nodes whose person is named by this normalized string, trying looser forms after the exact one. */
  private lookup(person: string): CandidateNode[] {
    const t = person.split(' ').filter(Boolean);
    if (t.length < 2) return [];
    const tries = [person];
    const noInitials = t.filter((x) => x.length > 1);
    if (noInitials.length >= 2 && noInitials.length !== t.length) tries.push(noInitials.join(' '));
    if (t.length >= 3) {
      tries.push(t.slice(0, 2).join(' '));
      tries.push(`${t[0]} ${t[t.length - 1]}`);
      tries.push(`${t[t.length - 1]} ${t[0]}`);
    }
    // The same forms again with a nickname swapped in for either end token.
    for (const k of [...tries]) {
      const w = k.split(' ');
      for (const i of [0, w.length - 1]) {
        for (const alt of NICKNAMES[w[i]] ?? []) {
          const v = [...w];
          v[i] = alt;
          tries.push(v.join(' '));
        }
      }
    }
    for (const k of tries) {
      const hit = this.byKey.get(k);
      if (hit && hit.length > 0) return hit;
    }
    return [];
  }

  /**
   * The candidate a payee string names. `date` is the row's date; `span` is
   * the range of dates an entity's rows cover, for judging a whole entity.
   */
  match(
    raw: string,
    date?: string | null,
    span?: { from: string | null; to: string | null } | null,
  ): CandidateMatch {
    const parsed = campaignName(raw);
    const options = this.lookup(parsed.person);
    const none = { node: null, options, parsed, federal: false };
    if (options.length === 0) return none;
    let pool = options;
    if (parsed.office) {
      const code = officeCodeFromPhrase(parsed.office);
      if (code === 'FEDERAL') return { ...none, federal: true };
      if (code) {
        pool = pool.filter((n) => n.officeCode === code);
      } else {
        const words = parsed.office.split(' ').filter((w) => COUNTY_OFFICE_WORDS.has(w));
        if (words.length > 0) {
          pool = pool.filter(
            (n) => n.office !== null && words.some((w) => normalizeName(n.office as string).includes(w)),
          );
        }
      }
      if (pool.length === 0) return none;
    }
    // Dates decide between a person's campaigns, and also reject the only
    // campaign on record when the money is dated years away from it: a 2023
    // contribution to a senator whose one node is a 2026 statewide run is a
    // race this data never loaded, not that run.
    let from: number | null = null;
    let to: number | null = null;
    if (date) from = to = Date.parse(date);
    else if (span?.from && span?.to) {
      from = Date.parse(span.from);
      to = Date.parse(span.to);
    }
    if (from !== null && to !== null && Number.isFinite(from) && Number.isFinite(to)) {
      pool = pool.filter((n) => inSpan(n, from as number, to as number));
    }
    return { node: pool.length === 1 ? pool[0] : null, options, parsed, federal: false };
  }
}
