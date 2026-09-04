/**
 * Client for ProPublica's Nonprofit Explorer API.
 *
 * The dark-money committees that fund the Stafford Jones network are 501(c)(4)
 * corporations, not campaign committees, so they file Form 990 with the IRS
 * rather than anything with a state election office. ProPublica republishes the
 * IRS extracts as JSON, keyed by EIN, with no key required.
 *
 * What is dependable here is the organisation's identity and tax status: name,
 * address, and the subsection code that says 501(c)(3) from (c)(4) from (c)(6).
 * The financials are only as complete as the IRS e-file extract — a year filed
 * on paper comes back as a PDF link with no numbers, so a caller must treat a
 * missing figure as unknown, not zero. The registered agent and the board are
 * not in a 990 at all; those come from the Sunbiz overlay in the adapter.
 *
 * Contract notes:
 *   - `/organizations/{ein}.json`, EIN as 9 digits, no dashes.
 *   - A 404 means the EIN is not in the IRS Business Master File — a real
 *     answer ("no such org"), returned as null rather than thrown.
 *   - `filings_with_data` carries the extracted financials, one row per tax
 *     year; `filings_without_data` is PDF-only years with no numbers.
 */
export const PROPUBLICA_BASE = 'https://projects.propublica.org/nonprofits/api/v2';

/** Browser-ish, but honest about who is calling. */
const USER_AGENT =
  process.env.PROPUBLICA_USER_AGENT ??
  'PACTracker/0.1 (+https://github.com/mydataismydata/PAC-Tracker)';

/** The organisation record, as much of it as this ingest reads. */
export interface Propublica990Org {
  ein: number;
  name: string;
  subsection_code: number | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
  ntee_code: string | null;
  ruling_date: string | null;
}

/** One year's return. A `filings_without_data` row leaves the figures null. */
export interface Propublica990Filing {
  tax_prd_yr: number | null;
  totrevenue: number | null;
  totfuncexpns: number | null;
  totcntrbgfts: number | null;
  totassetsend: number | null;
  pdf_url: string | null;
}

export interface Propublica990Response {
  organization: Propublica990Org;
  filings_with_data: Propublica990Filing[];
  filings_without_data: Propublica990Filing[];
}

export class Propublica990Error extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'Propublica990Error';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Propublica990ClientOptions {
  delayMs?: number;
  maxRetries?: number;
  onRequest?: (info: { url: string; attempt: number }) => void;
}

export class Propublica990Client {
  private readonly delayMs: number;
  private readonly maxRetries: number;
  private readonly onRequest?: Propublica990ClientOptions['onRequest'];
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(opts: Propublica990ClientOptions = {}) {
    this.delayMs = opts.delayMs ?? Number(process.env.PROPUBLICA_REQUEST_DELAY_MS ?? 600);
    this.maxRetries = opts.maxRetries ?? 3;
    this.onRequest = opts.onRequest;
  }

  /**
   * The 990 record for one EIN, or null when the EIN is unknown to the IRS.
   *
   * Serialized and spaced like the other government clients here: ProPublica is
   * a free public service, and a burst of parallel requests is what gets a
   * caller rate-limited off it.
   */
  async organization(ein: string): Promise<Propublica990Response | null> {
    const digits = ein.replace(/\D/g, '');
    if (digits.length !== 9) throw new Propublica990Error(`EIN must be 9 digits, got "${ein}"`);
    const url = `${PROPUBLICA_BASE}/organizations/${digits}.json`;

    const run = async (): Promise<Propublica990Response | null> => {
      const elapsed = Date.now() - this.lastRequestAt;
      if (elapsed < this.delayMs) await sleep(this.delayMs - elapsed);

      let lastError: unknown;
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        this.onRequest?.({ url, attempt });
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(30_000),
          });
          this.lastRequestAt = Date.now();
          if (res.status === 404) return null;
          // 429 and 5xx are transient — back off and retry rather than give up.
          if (res.status === 429 || res.status >= 500) {
            throw new Propublica990Error(`upstream ${res.status}`, res.status);
          }
          if (!res.ok) throw new Propublica990Error(`unexpected ${res.status}`, res.status);
          return (await res.json()) as Propublica990Response;
        } catch (err) {
          lastError = err;
          this.lastRequestAt = Date.now();
          if (attempt < this.maxRetries) await sleep(this.delayMs * 2 ** attempt);
        }
      }
      throw lastError instanceof Error ? lastError : new Propublica990Error(String(lastError));
    };

    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
