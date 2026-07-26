/**
 * HTTP client for VoterFocus county campaign finance portals.
 *
 * Contract notes discovered by probing the live service:
 *   - The `/ws/WScand/` path 302s to `/CampaignFinance/`; POST there directly,
 *     because following the redirect drops the body and the origin answers 411.
 *   - A PHP session cookie is required, so the form page is fetched once to
 *     establish it before any export.
 *   - `export.php?op=CFINANCE&cand_id=<id>&county=<slug>` returns a per-entity
 *     CSV of contributions *and* expenditures. This is far more reliable than
 *     the transaction search form, whose results are scoped to whatever
 *     election the session happens to have selected.
 */

const BASE = 'https://www.voterfocus.com/CampaignFinance';

export interface VoterFocusClientOptions {
  delayMs?: number;
  maxRetries?: number;
  userAgent?: string;
  onRequest?: (info: { url: string; attempt: number }) => void;
}

export class VoterFocusError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'VoterFocusError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VoterFocusClient {
  private readonly delayMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly onRequest?: VoterFocusClientOptions['onRequest'];

  /** Raw Cookie header value, carried across requests. */
  private cookie = '';
  private primed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(opts: VoterFocusClientOptions = {}) {
    this.delayMs = opts.delayMs ?? Number(process.env.VOTERFOCUS_REQUEST_DELAY_MS ?? 1000);
    this.maxRetries = opts.maxRetries ?? Number(process.env.VOTERFOCUS_MAX_RETRIES ?? 3);
    this.userAgent =
      opts.userAgent ??
      process.env.FLDOE_USER_AGENT ??
      'PACTracker/0.1 (+https://github.com/mydataismydata/PAC-Tracker)';
    this.onRequest = opts.onRequest;
  }

  /** Fetch the search page once so the origin issues a PHP session cookie. */
  private async prime(county: string): Promise<void> {
    if (this.primed) return;
    const res = await fetch(`${BASE}/cand_srch.php?c=${encodeURIComponent(county)}`, {
      headers: { 'User-Agent': this.userAgent },
      signal: AbortSignal.timeout(60_000),
    });
    this.captureCookies(res);
    this.primed = true;
  }

  private captureCookies(res: Response): void {
    // getSetCookie is the only way to see multiple Set-Cookie headers.
    const raw = res.headers.getSetCookie?.() ?? [];
    if (raw.length === 0) return;
    const jar = new Map(
      this.cookie
        .split('; ')
        .filter(Boolean)
        .map((c) => {
          const i = c.indexOf('=');
          return [c.slice(0, i), c.slice(i + 1)] as const;
        }),
    );
    for (const line of raw) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** GET a path under /CampaignFinance, serialized and rate-limited. */
  async get(path: string, county: string): Promise<string> {
    const run = async (): Promise<string> => {
      await this.prime(county);

      const elapsed = Date.now() - this.lastRequestAt;
      if (elapsed < this.delayMs) await sleep(this.delayMs - elapsed);

      const url = `${BASE}/${path}`;
      let lastError: unknown;

      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        this.onRequest?.({ url, attempt });
        try {
          const res = await fetch(url, {
            headers: {
              'User-Agent': this.userAgent,
              Accept: 'text/html,text/csv,application/vnd.ms-excel,*/*',
              Referer: `${BASE}/cand_srch.php?c=${encodeURIComponent(county)}`,
              ...(this.cookie ? { Cookie: this.cookie } : {}),
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(120_000),
          });
          this.lastRequestAt = Date.now();
          this.captureCookies(res);

          if (res.status >= 500) throw new VoterFocusError(`upstream ${res.status}`, res.status);
          if (!res.ok) throw new VoterFocusError(`HTTP ${res.status}`, res.status);
          return await res.text();
        } catch (err) {
          lastError = err;
          this.lastRequestAt = Date.now();
          if (attempt < this.maxRetries) await sleep(this.delayMs * 2 ** attempt);
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new VoterFocusError(`request failed: ${String(lastError)}`);
    };

    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
