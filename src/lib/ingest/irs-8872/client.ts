/**
 * HTTP client for the IRS Political Organization Filing & Disclosure site.
 *
 * 527 organizations that are not FEC-reporting disclose their contributions on
 * Form 8872, filed with the IRS rather than any state. That is the only place
 * the funding of a national committee like the RSLC appears — it can send
 * millions into Florida races while reporting nothing to Florida.
 *
 * Contract notes discovered by probing the live service:
 *   - The bulk downloads (`/dataDownload/fullData`, `/dataAG`, `/dataNR`, …)
 *     all 302 to a 404 page as of 2026-08. They are the only structured feed,
 *     so if they come back they are strictly better than scraping PDFs. Tested
 *     with browser headers, a primed session and a referer — not a bot block.
 *   - Search is Spring Web Flow: the first GET establishes a session and the
 *     POST carries `execution=e1s1`.
 *   - The POST answers 302, and following it *as a POST* re-sends without a
 *     body, which the origin rejects with 411. The redirect has to be followed
 *     with a GET.
 *   - EIN is split across two fields, 2 digits and 7.
 *   - One EIN can return several name variants (the RSLC has four); each has
 *     its own detail page, and filings must be gathered across all of them.
 *   - Filings themselves are PDFs, ~2.6MB and ~1,300 pages per quarter.
 */

const BASE = 'https://forms.irs.gov';

export const IRS_ENDPOINTS = {
  search: `${BASE}/app/pod/basicSearch/search`,
  results: `${BASE}/app/pod/basicSearch/BasicSearchResults`,
} as const;

/** Browser-ish, but honest about who is calling. */
const USER_AGENT =
  process.env.IRS_USER_AGENT ??
  'PACTracker/0.1 (+https://github.com/mydataismydata/PAC-Tracker)';

export class IrsPodError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'IrsPodError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface IrsClientOptions {
  delayMs?: number;
  maxRetries?: number;
  onRequest?: (info: { url: string; attempt: number }) => void;
}

export class IrsPodClient {
  private readonly delayMs: number;
  private readonly maxRetries: number;
  private readonly onRequest?: IrsClientOptions['onRequest'];
  /** fetch() keeps no cookie jar, and the search flow is session-bound. */
  private cookies = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(opts: IrsClientOptions = {}) {
    this.delayMs = opts.delayMs ?? Number(process.env.IRS_REQUEST_DELAY_MS ?? 1200);
    this.maxRetries = opts.maxRetries ?? 3;
    this.onRequest = opts.onRequest;
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private storeCookies(res: Response): void {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  /** Serialized and spaced, because this is a government service. */
  private async request(
    url: string,
    init: RequestInit & { referer?: string } = {},
  ): Promise<Response> {
    const run = async (): Promise<Response> => {
      const elapsed = Date.now() - this.lastRequestAt;
      if (elapsed < this.delayMs) await sleep(this.delayMs - elapsed);

      let lastError: unknown;
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        this.onRequest?.({ url, attempt });
        try {
          const res = await fetch(url, {
            ...init,
            // Redirects are handled by the caller: the search POST must not be
            // replayed as a POST, and 302 -> GET is the only shape that works.
            redirect: 'manual',
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'text/html,application/xhtml+xml,application/pdf,*/*',
              ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
              ...(init.referer ? { Referer: init.referer } : {}),
              ...(init.headers ?? {}),
            },
            signal: AbortSignal.timeout(180_000),
          });
          this.lastRequestAt = Date.now();
          this.storeCookies(res);
          if (res.status >= 500) throw new IrsPodError(`upstream ${res.status}`, res.status);
          return res;
        } catch (err) {
          lastError = err;
          this.lastRequestAt = Date.now();
          if (attempt < this.maxRetries) await sleep(this.delayMs * 2 ** attempt);
        }
      }
      throw lastError instanceof Error ? lastError : new IrsPodError(String(lastError));
    };

    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Establish the session the search flow requires. */
  async primeSession(): Promise<void> {
    const res = await this.request(IRS_ENDPOINTS.search);
    if (!res.ok) throw new IrsPodError(`could not open search page: ${res.status}`, res.status);
    await res.text();
  }

  /**
   * Search Form 8872 filers by EIN, returning the results page HTML.
   *
   * The POST answers 302; the location is fetched with a GET because replaying
   * the POST drops the body and the origin answers 411.
   */
  async searchByEin(ein: string): Promise<string> {
    const digits = ein.replace(/\D/g, '');
    if (digits.length !== 9) throw new IrsPodError(`EIN must be 9 digits, got "${ein}"`);

    const body = new URLSearchParams({
      f8872: 'true',
      OrgName: '',
      ein1: digits.slice(0, 2),
      ein2: digits.slice(2),
      fromMonth: '', fromDay: '', fromYear: '',
      toMonth: '', toDay: '', toYear: '',
      execution: 'e1s1',
      _eventId_submit: 'Submit Basic Search',
    });

    const posted = await this.request(IRS_ENDPOINTS.search, {
      method: 'POST',
      body,
      referer: IRS_ENDPOINTS.search,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const location = posted.headers.get('location') ?? IRS_ENDPOINTS.results;
    const url = location.startsWith('http') ? location : `${BASE}${location}`;
    const res = await this.request(url, { referer: IRS_ENDPOINTS.search });
    if (!res.ok) throw new IrsPodError(`search results ${res.status}`, res.status);
    return res.text();
  }

  /** Fetch a detail or paged detail page. */
  async fetchPage(path: string): Promise<string> {
    const url = path.startsWith('http') ? path : `${BASE}${path}`;
    const res = await this.request(url, { referer: IRS_ENDPOINTS.results });
    if (!res.ok) throw new IrsPodError(`page ${res.status} for ${path}`, res.status);
    return res.text();
  }

  /** Download one filing as a PDF. */
  async downloadForm(path: string): Promise<Uint8Array> {
    const url = path.startsWith('http') ? path : `${BASE}${path}`;
    const res = await this.request(url, { referer: IRS_ENDPOINTS.results });
    if (!res.ok) throw new IrsPodError(`form download ${res.status}`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
}
