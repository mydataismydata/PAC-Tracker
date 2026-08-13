/**
 * IRS Form 8872 source adapter, scoped to named organizations.
 *
 * This is not a bulk import. It exists to answer one question the Florida data
 * cannot: where a *national* committee's money comes from, when that committee
 * sends millions into Florida races while reporting nothing to Florida.
 *
 * Money loaded through here belongs to a national pool. It is deliberately not
 * treated as an ordinary upstream hop — see `entities.isInjectionPoint`.
 */

import { IrsPodClient } from './client';
import {
  parseIrs8872Pdf,
  parseSearchResults,
  parseDetailPage,
  type Irs8872Filing,
  type FilingLink,
} from './parse';

/** Organizations worth loading, with the EIN their filings are keyed by. */
export const TRACKED_ORGS = [
  {
    slug: 'rslc',
    ein: '050532524',
    name: 'Republican State Leadership Committee',
    note: 'Sent $3.5M into six Florida committees across 2025–2026.',
  },
] as const;

export function findOrg(slug: string) {
  return TRACKED_ORGS.find((o) => o.slug === slug.toLowerCase());
}

export interface SweepOptions {
  /** Only filings whose period *ends* on or after this ISO date. */
  from?: string;
  to?: string;
  /**
   * Skip contributions below this.
   *
   * Not a shortcut: for the RSLC, 92% of rows are under $100 and carry 3.4% of
   * the money, while 201 rows at $10k or more carry 92.7%. Loading the tail
   * adds ~11,000 national individuals per quarter for a rounding error.
   */
  minAmount?: number;
  onProgress?: (msg: string) => void;
}

export class Irs8872Adapter {
  readonly sourceKey = 'irs-8872';

  constructor(private readonly client: IrsPodClient = new IrsPodClient()) {}

  /**
   * Every filing for an EIN in a date range, parsed.
   *
   * A single EIN can be registered under several names — the RSLC has four —
   * each with its own detail page, so filings are gathered across all of them
   * and de-duplicated by form id.
   */
  async *sweepOrganization(
    ein: string,
    opts: SweepOptions = {},
  ): AsyncGenerator<{ link: FilingLink; filing: Irs8872Filing }> {
    const log = opts.onProgress ?? (() => {});

    await this.client.primeSession();
    const results = await this.client.searchByEin(ein);
    const detailUrls = parseSearchResults(results);
    if (detailUrls.length === 0) {
      throw new Error(`no Form 8872 filers found for EIN ${ein}`);
    }
    log(`${detailUrls.length} name variant(s) registered under EIN ${ein}`);

    const seen = new Set<string>();
    const links: FilingLink[] = [];
    for (const url of detailUrls) {
      for (const link of await this.listFilings(url)) {
        if (seen.has(link.formId)) continue;
        seen.add(link.formId);
        links.push(link);
      }
    }

    const wanted = links
      .filter((l) => {
        if (!l.periodEnd) return false;
        if (opts.from && l.periodEnd < opts.from) return false;
        if (opts.to && l.periodEnd > opts.to) return false;
        return true;
      })
      .sort((a, b) => (a.periodEnd ?? '').localeCompare(b.periodEnd ?? ''));

    log(`${links.length} filings total, ${wanted.length} in range`);

    for (const link of wanted) {
      log(`fetching filing ${link.formId} (period ending ${link.periodEnd})…`);
      const pdf = await this.client.downloadForm(link.href);
      const filing = await parseIrs8872Pdf(pdf, { minAmount: opts.minAmount });
      yield { link, filing };
    }
  }

  /** Walk the paginated filing list on one detail page. */
  private async listFilings(detailUrl: string): Promise<FilingLink[]> {
    const out: FilingLink[] = [];
    const seen = new Set<string>();
    let url: string | null = detailUrl;
    // Bounded: ~19 pages for a committee filing since 2003, and a malformed
    // "next" link must not spin forever.
    for (let page = 0; url && page < 40; page++) {
      const html: string = await this.client.fetchPage(url);
      const { filings, nextPage } = parseDetailPage(html);
      const fresh = filings.filter((f) => !seen.has(f.formId));
      for (const f of fresh) seen.add(f.formId);
      out.push(...fresh);
      if (fresh.length === 0) break;
      url = nextPage;
    }
    return out;
  }
}
