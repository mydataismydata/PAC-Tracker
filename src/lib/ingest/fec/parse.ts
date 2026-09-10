/**
 * Map OpenFEC schedule rows onto the shape every source adapter produces.
 *
 * Schedule A is money in and Schedule B is money out, both reported by the
 * committee itself. That maps cleanly onto `RawTransactionRow`: the committee
 * is always the filer, and the direction says which way the money went.
 */

import { createHash } from 'node:crypto';
import type { CounterpartyKind, RawTransactionRow } from '../types';

/** Schedule A — a receipt, as the API returns it. Only the fields we use. */
export interface ScheduleARow {
  sub_id: string;
  contributor_name: string | null;
  contributor_city: string | null;
  contributor_state: string | null;
  contributor_zip: string | null;
  contributor_occupation: string | null;
  contributor_employer: string | null;
  entity_type_desc: string | null;
  contribution_receipt_date: string | null;
  contribution_receipt_amount: number | null;
  receipt_type_desc: string | null;
  memo_code: string | null;
  memo_text: string | null;
  two_year_transaction_period: number | null;
}

/** Schedule B — a disbursement. */
export interface ScheduleBRow {
  sub_id: string;
  recipient_name: string | null;
  recipient_city: string | null;
  recipient_state: string | null;
  recipient_zip: string | null;
  disbursement_date: string | null;
  disbursement_amount: number | null;
  disbursement_description: string | null;
  disbursement_type_desc: string | null;
  memo_code: string | null;
  two_year_transaction_period: number | null;
}

/**
 * The FEC's entity type, in our vocabulary.
 *
 * `CCM` and `PAC` are both committees and both traversable. `ORG` covers
 * corporations, unions and trade associations, which are terminal here the
 * same way a Florida corporate donor is.
 */
const ENTITY_TYPES: Record<string, CounterpartyKind> = {
  'INDIVIDUAL': 'individual',
  'INDIVIDUAL - PERSON': 'individual',
  'CANDIDATE': 'committee',
  'CANDIDATE COMMITTEE': 'committee',
  'POLITICAL ACTION COMMITTEE': 'committee',
  'POLITICAL PARTY ORGANIZATION': 'party',
  'ORGANIZATION': 'business',
  'PARTNERSHIP': 'business',
};

function kindOf(desc: string | null): CounterpartyKind {
  if (!desc) return 'unknown';
  return ENTITY_TYPES[desc.trim().toUpperCase()] ?? 'unknown';
}

/**
 * `sub_id` is the FEC's own identifier for a filed line and never repeats, so
 * it is the whole dedupe key. Hashed only to keep the column's shape uniform
 * across sources, and namespaced so it can never collide with another feed.
 */
function rowHash(subId: string): string {
  return createHash('sha256').update(`fec|${subId}`).digest('hex').slice(0, 32);
}

/**
 * True for a line that is the candidate's own capital, not a contribution.
 *
 * A candidate may lend a campaign money and be repaid out of what it raises
 * later. Both halves move real dollars, and neither is a donation: the loan is
 * a liability the committee owes, and the repayment is that debt being settled.
 *
 * Counting the inflow as giving is not a rounding error. Randy Fine lent his
 * committee $950,000 across three unsecured, interest-free loans in 2025, none
 * of it repaid — and booked as contributions those three rows made him the
 * largest donor in his own file, ahead of every PAC and every person. A
 * funding-origins trace would then credit him as the source of a quarter of
 * that campaign's money, which the filing does not say and the data cannot
 * support: a candidate's personal funds have no disclosure trail at all.
 *
 * The loans themselves are on Schedule C, which records the source, whether
 * they were secured, and what is still outstanding. That is where a loan
 * belongs, not in a graph of who gave what to whom.
 */
function isCandidateCapital(typeCode: string | null): boolean {
  const code = (typeCode ?? '').toUpperCase();
  return code.includes('LOAN');
}

/**
 * True for a line that restates money itemized elsewhere in the same report.
 *
 * The FEC flags these with a memo code. They exist so a reader can see the
 * parts of an earmarked or partnership contribution, and the total is already
 * counted on the parent line — loading both would double the money. This is
 * the federal equivalent of the mirror problem, except the filer marks it.
 */
function isMemo(memoCode: string | null): boolean {
  return typeof memoCode === 'string' && memoCode.trim() !== '';
}

export interface FilerContext {
  /** The committee's name as it should appear in the graph. */
  filerName: string;
  /** Namespaced cycle key, e.g. `fec-2026`. */
  electionCycle: string;
}

export function scheduleAToRow(r: ScheduleARow, ctx: FilerContext): RawTransactionRow | null {
  if (isMemo(r.memo_code)) return null;
  if (isCandidateCapital(r.receipt_type_desc)) return null;
  const name = r.contributor_name?.trim();
  if (!name || r.contribution_receipt_amount == null) return null;

  return {
    filerRaw: ctx.filerName,
    filerTruncated: false,
    filerTypeTag: null,
    filerOffice: null,
    filerParty: null,
    filerIsCommittee: true,
    counterpartyRaw: name,
    counterpartyKind: kindOf(r.entity_type_desc),
    direction: 'contribution',
    amount: String(r.contribution_receipt_amount),
    date: r.contribution_receipt_date?.slice(0, 10) ?? null,
    typeCode: r.receipt_type_desc?.slice(0, 60) ?? null,
    description: null,
    address: null,
    city: r.contributor_city,
    state: r.contributor_state,
    zip: r.contributor_zip,
    // Employer is the useful half for a federal donor: occupation is often
    // blank on a PAC row, and the employer is what ties a person to an industry.
    occupation: r.contributor_occupation ?? r.contributor_employer,
    electionCycle: ctx.electionCycle,
    rowHash: rowHash(r.sub_id),
  };
}

export function scheduleBToRow(r: ScheduleBRow, ctx: FilerContext): RawTransactionRow | null {
  if (isMemo(r.memo_code)) return null;
  // The other half of the same thing: a repayment is debt being settled, not
  // the committee funding anyone.
  if (isCandidateCapital(r.disbursement_type_desc)) return null;
  const name = r.recipient_name?.trim();
  if (!name || r.disbursement_amount == null) return null;

  return {
    filerRaw: ctx.filerName,
    filerTruncated: false,
    filerTypeTag: null,
    filerOffice: null,
    filerParty: null,
    filerIsCommittee: true,
    counterpartyRaw: name,
    // Schedule B carries no entity type at all, so the payee is left for
    // resolution to classify from the name — the same position the Florida
    // expenditure feed puts us in.
    counterpartyKind: 'unknown',
    direction: 'expenditure',
    amount: String(r.disbursement_amount),
    date: r.disbursement_date?.slice(0, 10) ?? null,
    typeCode: r.disbursement_type_desc?.slice(0, 60) ?? null,
    description: r.disbursement_description,
    address: null,
    city: r.recipient_city,
    state: r.recipient_state,
    zip: r.recipient_zip,
    occupation: null,
    electionCycle: ctx.electionCycle,
    rowHash: rowHash(r.sub_id),
  };
}
