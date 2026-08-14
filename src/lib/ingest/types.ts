/**
 * The shape every source adapter produces.
 *
 * Sources disagree about what a row *is*. Florida's state export lists only
 * contributions, always described from the recipient's point of view. County
 * VoterFocus exports interleave contributions and expenditures in one file,
 * always described from the filer's point of view. Normalizing to a filer plus
 * a counterparty plus a direction lets one pipeline consume both, and keeps
 * expenditures — money leaving a committee — in the graph instead of dropping
 * them.
 */

export type TransactionDirection = 'contribution' | 'expenditure';

/** Hint from the source about what kind of thing the counterparty is. */
export type CounterpartyKind =
  | 'individual'
  | 'business'
  | 'committee'
  | 'party'
  | 'self'
  | 'other'
  | 'unknown';

export interface RawTransactionRow {
  /** The candidate or committee whose report this row came from. */
  filerRaw: string;
  /** Name as filed, before any truncation handling. */
  filerTruncated: boolean;
  /** Source's type tag for the filer, e.g. Florida's "(PAC)". */
  filerTypeTag: string | null;
  /** Office sought, when the source reports it. County sources usually do. */
  filerOffice: string | null;
  filerParty: string | null;
  /** True when the filer is a committee rather than a candidate. */
  filerIsCommittee: boolean | null;

  /** The other side: a donor for contributions, a vendor for expenditures. */
  counterpartyRaw: string;
  /**
   * What the source says the counterparty is. Florida's state export offers
   * nothing here, which is why resolution has to guess; VoterFocus supplies a
   * real code, and a `committee` value is strong evidence the node is
   * traversable.
   */
  counterpartyKind: CounterpartyKind;

  /**
   * `contribution` means money flowed counterparty -> filer.
   * `expenditure` means money flowed filer -> counterparty.
   */
  direction: TransactionDirection;

  amount: string;
  date: string | null;
  /** Source's own instrument code, e.g. CHE / CA / CH / LO / MO. */
  typeCode: string | null;
  description: string | null;

  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  occupation: string | null;

  /** Stable dedupe key across re-ingests of the same underlying filing. */
  /**
   * Election cycle this filing belongs to, when the source knows it.
   *
   * County sweeps are scoped to one cycle, so stamping it here beats inferring
   * it from the transaction date: post-election filings for a closing cycle are
   * dated after the election and would otherwise be booked to the next one.
   */
  electionCycle?: string;

  rowHash: string;
}

/** Resolve the (from, to) pair a row implies. */
export function directedEnds(row: RawTransactionRow): { fromRaw: string; toRaw: string } {
  return row.direction === 'contribution'
    ? { fromRaw: row.counterpartyRaw, toRaw: row.filerRaw }
    : { fromRaw: row.filerRaw, toRaw: row.counterpartyRaw };
}
