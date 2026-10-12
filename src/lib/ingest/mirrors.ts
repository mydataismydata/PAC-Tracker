/**
 * Pair a payer's expenditures with the recipient's contributions for the same
 * transfers, one to one.
 *
 * Kept apart from the pipeline so the pairing can be checked without a
 * database. `collapseMirrors` loads the rows, asks this module which pairs are
 * one transfer filed twice, and deletes the expenditure of each pair.
 */

/** One filed row, as the pairing sees it. */
export type MirrorRow = {
  id: string;
  /** The row's `source_row_hash`. A pairing is recorded by hash, not by id. */
  hash: string;
  amount: number;
  /** Milliseconds since the epoch, or null for an undated row. */
  date: number | null;
};

/** How far apart, in days, two filings of one transfer may be dated. */
export type MirrorWindow = {
  /** Days the recipient's date may trail the payer's. */
  recipientLag: number;
  /** Days the payer's date may trail the recipient's. */
  payerLag: number;
};

export type MirrorPair = { expenditure: MirrorRow; contribution: MirrorRow };

const DAY = 86_400_000;

/**
 * Pair expenditures with contributions between one payer and one recipient.
 *
 * Every pair is one transfer that both filers reported, so a contribution can
 * pair with one expenditure at most, ever. The caller passes in only the
 * contributions no earlier collapse has spoken for. Without that, a receipt
 * used once could be used again, and it was: Ponte Vedra Democratic Club paid
 * the St. Johns Democrats $100 nine times in 2017, the committee booked five
 * $100 receipts, and repeated sweeps deleted all nine payments against those
 * five.
 *
 * Inside the call the matching is a maximum one: as many pairs as the window
 * allows, so no expenditure is left stranded because a nearer-dated one took
 * its only partner. Each expenditure tries its nearest partners first, and the
 * inputs arrive in a fixed order, so two databases holding the same rows pair
 * them the same way.
 *
 * `prior` maps an expenditure's hash to the contribution hash it was paired
 * with before it was deleted. A sweep that brings the same filing back
 * restores that pair first, so the record does not wander to another receipt.
 */
export function pairMirrors(
  expenditures: MirrorRow[],
  contributions: MirrorRow[],
  window: MirrorWindow,
  prior: ReadonlyMap<string, string> = new Map(),
): MirrorPair[] {
  const recipientLag = window.recipientLag * DAY;
  const payerLag = window.payerLag * DAY;

  // Same amount, both dated, within the window. When unsure, leave it be.
  const lagOf = (e: MirrorRow, c: MirrorRow): number | null => {
    if (c.amount !== e.amount || c.date === null || e.date === null) return null;
    const lag = c.date - e.date; // positive: the recipient booked it after the payer
    if (lag > recipientLag || -lag > payerLag) return null;
    return lag;
  };

  // Each expenditure's possible partners, nearest date first.
  const options = expenditures.map((e) =>
    contributions
      .map((c, i) => ({ i, lag: lagOf(e, c) }))
      .filter((o): o is { i: number; lag: number } => o.lag !== null)
      .sort((a, b) => Math.abs(a.lag) - Math.abs(b.lag) || a.i - b.i)
      .map((o) => o.i),
  );

  const partnerOf = new Array<number>(contributions.length).fill(-1);
  const fixed = new Array<boolean>(expenditures.length).fill(false);

  // A pair recorded before stands, provided both rows are still here and fit.
  const contributionByHash = new Map(contributions.map((c, i) => [c.hash, i]));
  expenditures.forEach((e, ei) => {
    const ci = contributionByHash.get(prior.get(e.hash) ?? '');
    if (ci === undefined || partnerOf[ci] !== -1 || !options[ei].includes(ci)) return;
    partnerOf[ci] = ei;
    fixed[ei] = true;
  });

  // Augmenting paths (Kuhn's algorithm). An expenditure takes a free partner,
  // or takes a held one if the holder can move to another. Restored pairs
  // never move.
  const claim = (ei: number, seen: boolean[]): boolean => {
    for (const ci of options[ei]) {
      if (seen[ci]) continue;
      seen[ci] = true;
      const holder = partnerOf[ci];
      if (holder === -1 || (!fixed[holder] && claim(holder, seen))) {
        partnerOf[ci] = ei;
        return true;
      }
    }
    return false;
  };
  expenditures.forEach((_, ei) => {
    if (!fixed[ei]) claim(ei, new Array<boolean>(contributions.length).fill(false));
  });

  const pairs: MirrorPair[] = [];
  partnerOf.forEach((ei, ci) => {
    if (ei !== -1) pairs.push({ expenditure: expenditures[ei], contribution: contributions[ci] });
  });
  // In expenditure order, so callers and tests see a stable list.
  const order = new Map(expenditures.map((e, i) => [e, i]));
  return pairs.sort((a, b) => order.get(a.expenditure)! - order.get(b.expenditure)!);
}
