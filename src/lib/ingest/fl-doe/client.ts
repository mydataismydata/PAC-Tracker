/**
 * HTTP client for the Florida Division of Elections campaign finance system.
 *
 * The backing service is a 1990s-era CGI executable (`contrib.exe`) in front of
 * SQL Server, now sitting behind Cloudflare. It is fragile and slow, so this
 * client is deliberately conservative: serialized requests, a fixed delay
 * between them, bounded retries, and an honest User-Agent.
 *
 * Contract notes discovered by probing the live service:
 *   - A `Referer` from the search page is required; without it Cloudflare 502s.
 *   - `csort1` must be non-empty or the CGI emits a bare `ORDER BY` and returns
 *     a SQL Server syntax error inside an HTTP 200 body.
 *   - `rowlimit` is `maxlength=5` but parsed as Int16, so 32767 is the real
 *     ceiling; 32768 overflows instantly.
 *   - `queryformat=2` switches the response from HTML to tab-delimited text.
 */

const BASE = 'https://dos.elections.myflorida.com';

export const FLDOE_ENDPOINTS = {
  contributions: `${BASE}/cgi-bin/contrib.exe`,
  expenditures: `${BASE}/cgi-bin/expend.exe`,
  committeeLookup: `${BASE}/committees/ComLkupByName.asp`,
} as const;

const REFERERS: Record<keyof typeof FLDOE_ENDPOINTS, string> = {
  contributions: `${BASE}/campaign-finance/contributions/`,
  expenditures: `${BASE}/campaign-finance/expenditures/`,
  committeeLookup: `${BASE}/committees/`,
};

/**
 * Maximum value the `rowlimit` field actually accepts.
 *
 * The input is `maxlength=5`, which suggests 99999, but the CGI parses the
 * value into a 16-bit signed integer: anything above 32767 comes back as
 * "Overflow Error Number = 6" before the query even runs. The HTML attribute
 * is a lie, and the failure is instant rather than load-related, so it is easy
 * to misread as the service being down.
 */
export const MAX_ROW_LIMIT = 32767;

/**
 * What the user wants back. These map to the `search_on` radio, whose values
 * are non-obvious: the two "what would you like to know?" choices in each of
 * the candidate and committee blocks share one field with the mode selector.
 */
export const SEARCH_ON = {
  /** Contributor search, list only. */
  contributorList: 1,
  /** Candidate: list of individual contributions. */
  candidateList: 2,
  /** Candidate: contribution totals. */
  candidateTotals: 3,
  /** Committee: list of individual contributions. */
  committeeList: 4,
  /** Committee: contribution totals. */
  committeeTotals: 5,
} as const;

/** Name-matching mode for the *Name fields. */
export const NAME_MATCH = { containing: 1, startsWith: 2, soundsLike: 3 } as const;

export const SORT = { amountDesc: 'AMT', dateAsc: 'DAT', contributor: 'NAM', name: 'CAN' } as const;

export interface FlDoeClientOptions {
  delayMs?: number;
  maxRetries?: number;
  userAgent?: string;
  /** Called with every request for logging/observability. */
  onRequest?: (info: { endpoint: string; params: Record<string, string>; attempt: number }) => void;
}

export class FlDoeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'FlDoeError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FlDoeClient {
  private readonly delayMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly onRequest?: FlDoeClientOptions['onRequest'];
  /** Serializes every request through one promise chain. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(opts: FlDoeClientOptions = {}) {
    this.delayMs = opts.delayMs ?? Number(process.env.FLDOE_REQUEST_DELAY_MS ?? 1500);
    this.maxRetries = opts.maxRetries ?? Number(process.env.FLDOE_MAX_RETRIES ?? 3);
    this.userAgent =
      opts.userAgent ??
      process.env.FLDOE_USER_AGENT ??
      'PACTracker/0.1 (+https://github.com/mydataismydata/PAC-Tracker)';
    this.onRequest = opts.onRequest;
  }

  /**
   * POST a form, one request at a time, spaced by `delayMs`.
   *
   * Everything funnels through a single promise chain so that concurrent
   * callers cannot stampede the state's server.
   */
  async post(
    endpoint: keyof typeof FLDOE_ENDPOINTS,
    params: Record<string, string | number | undefined>,
  ): Promise<string> {
    const run = async (): Promise<string> => {
      const elapsed = Date.now() - this.lastRequestAt;
      if (elapsed < this.delayMs) await sleep(this.delayMs - elapsed);

      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) body.append(k, String(v));
      }

      let lastError: unknown;
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        this.onRequest?.({ endpoint, params: Object.fromEntries(body), attempt });
        try {
          const res = await fetch(FLDOE_ENDPOINTS[endpoint], {
            method: 'POST',
            headers: {
              'User-Agent': this.userAgent,
              'Content-Type': 'application/x-www-form-urlencoded',
              Referer: REFERERS[endpoint],
              Accept: 'text/html,text/plain,*/*',
            },
            body,
            signal: AbortSignal.timeout(180_000),
          });
          this.lastRequestAt = Date.now();

          // 502/503 from Cloudflare means the origin CGI choked; back off.
          if (res.status >= 500) {
            throw new FlDoeError(`upstream ${res.status}`, res.status);
          }
          if (!res.ok) {
            throw new FlDoeError(`HTTP ${res.status}`, res.status, await res.text());
          }

          const text = await res.text();
          assertNoCgiError(text);
          return text;
        } catch (err) {
          lastError = err;
          this.lastRequestAt = Date.now();
          if (attempt < this.maxRetries) {
            // Exponential backoff, since the failure mode is usually load.
            await sleep(this.delayMs * 2 ** attempt);
          }
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new FlDoeError(`request failed: ${String(lastError)}`);
    };

    const result = this.queue.then(run, run);
    // Keep the chain alive even when one request rejects.
    this.queue = result.catch(() => undefined);
    return result;
  }
}

/**
 * The CGI reports failures inside an HTTP 200 body, so status alone is not
 * enough — a malformed query comes back as an ODBC error in HTML after a
 * perfectly valid-looking TSV header row.
 */
function assertNoCgiError(text: string): void {
  if (text.includes('Error in /cgi-bin/')) {
    const detail = text.match(/<PRE>([\s\S]*?)<\/PRE>/i)?.[1]?.trim();
    throw new FlDoeError(`FL DOE CGI error: ${detail ?? 'unknown'}`, 200, text.slice(0, 500));
  }
  if (/Server Error|Internal server error/i.test(text) && text.length < 4000) {
    throw new FlDoeError('FL DOE returned a server error page', 200, text.slice(0, 500));
  }
}
