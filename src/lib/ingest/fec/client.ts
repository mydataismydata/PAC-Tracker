/**
 * HTTP client for the FEC's OpenFEC API.
 *
 * Federal candidates file with the Federal Election Commission, not with any
 * state, so none of their money reaches the Florida feeds. A federal committee
 * appears in the Florida data only when it *gives* to a state or county filer
 * and that filer reports receiving it — which is why "Randy Fine for Congress"
 * was already a node here with $5,000 out and nothing in.
 *
 * Unlike every other source in this project, this one is a real JSON API with
 * stable identifiers. No scraping, no PDFs, and `sub_id` is a natural dedupe
 * key. Two things about it still have to be worked around, both found by
 * probing the live service:
 *
 *   - **Schedule B times out without a cycle.** `/schedules/schedule_b/` with
 *     only a committee id answers 504 after ~16 seconds, sorted or not. Adding
 *     `two_year_transaction_period` returns the same query in under two
 *     seconds. Schedule A does not need it, but is scoped the same way for
 *     symmetry and so a sweep can be resumed one cycle at a time.
 *   - **Deep paging is keyset, not offset.** Each page returns
 *     `pagination.last_indexes`, whose keys are fed back as query parameters
 *     to fetch the next one. The `page` parameter exists but degrades on large
 *     result sets, and the API's own documentation steers to this.
 *
 * A 504 from this service is routine rather than fatal, so it is retried with
 * backoff alongside the usual 429 and 5xx.
 */

const BASE = 'https://api.open.fec.gov/v1';

export class FecError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FecError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What every OpenFEC list endpoint wraps its results in. */
export interface FecPage<T> {
  results: T[];
  pagination: {
    count: number;
    pages: number;
    per_page: number;
    /** Keyset cursor: the keys are literally the next request's parameters. */
    last_indexes: Record<string, string | number> | null;
  };
}

export interface FecClientOptions {
  apiKey?: string;
  delayMs?: number;
  maxRetries?: number;
  onRequest?: (info: { url: string; attempt: number }) => void;
}

export class FecClient {
  private readonly apiKey: string;
  private readonly delayMs: number;
  private readonly maxRetries: number;
  private readonly onRequest?: FecClientOptions['onRequest'];
  private lastRequestAt = 0;

  constructor(opts: FecClientOptions = {}) {
    const key = opts.apiKey ?? process.env.FEC_API_KEY;
    if (!key) {
      throw new FecError(
        'FEC_API_KEY is not set. Get one free at https://api.data.gov/signup/ and put ' +
          'it in .env — never in a committed file, and never on the command line, ' +
          'where it would land in shell history and in the server log as a query string.',
      );
    }
    this.apiKey = key;
    this.delayMs = opts.delayMs ?? Number(process.env.FEC_REQUEST_DELAY_MS ?? 250);
    this.maxRetries = opts.maxRetries ?? 4;
    this.onRequest = opts.onRequest;
  }

  /** One request, rate-limited and retried. */
  async get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const q = new URLSearchParams({ api_key: this.apiKey });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') q.set(k, String(v));
    }
    const url = `${BASE}${path}?${q}`;
    // The key is in the query string because the API takes it nowhere else.
    // Everything logged from here strips it.
    const shown = url.replace(this.apiKey, '…');

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const wait = this.delayMs - (Date.now() - this.lastRequestAt);
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      this.onRequest?.({ url: shown, attempt });

      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        if (attempt === this.maxRetries) throw new FecError(`${shown}: ${String(err)}`);
        await sleep(1000 * attempt ** 2);
        continue;
      }

      if (res.ok) return (await res.json()) as T;

      // 504 is this service's ordinary answer to a query it found expensive,
      // not a broken request; 429 is the rate limiter. Both are worth waiting
      // out. Anything else is ours to fix and fails immediately.
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === this.maxRetries) {
        throw new FecError(`${shown} -> HTTP ${res.status}`, res.status);
      }
      await sleep(1000 * attempt ** 2);
    }
    throw new FecError(`${shown}: retries exhausted`);
  }

  /**
   * Walk every page of a list endpoint, yielding results as they arrive.
   *
   * Paging is by keyset: whatever `last_indexes` comes back becomes the next
   * request's parameters. A page that returns nothing, or no cursor, ends the
   * walk — both happen on the final page depending on the endpoint.
   */
  async *paginate<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    onPage?: (fetched: number, total: number) => void,
  ): AsyncGenerator<T> {
    let cursor: Record<string, string | number> = {};
    let fetched = 0;
    for (;;) {
      const page = await this.get<FecPage<T>>(path, { ...params, ...cursor });
      for (const row of page.results) yield row;
      fetched += page.results.length;
      onPage?.(fetched, page.pagination?.count ?? 0);
      const next = page.pagination?.last_indexes;
      if (page.results.length === 0 || !next || Object.keys(next).length === 0) return;
      cursor = next;
    }
  }
}
