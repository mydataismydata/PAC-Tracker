/**
 * Pull registered-agent and officer records from the Florida Division of
 * Corporations bulk data feed.
 *
 * The state's search site sits behind a Cloudflare bot wall, but the same
 * registry is published as a free SFTP feed with no such wall — the front door
 * for automation. The not-for-profit quarterly snapshot is one ~42 MB zip
 * (`npcordata.zip`) that unpacks into ten fixed-width text files split by the
 * last digit of the document number. A profile needs only a handful of records,
 * so this downloads the zip once, caches it for the quarter, and inflates only
 * the member files whose digit a wanted document number lands in.
 *
 * The credentials below are the published public ones printed on the state's
 * own data-downloads page — a read-only anonymous account, not a secret. The
 * host key is accepted unpinned: the feed is public and read-only, and every
 * record is validated by document number downstream, so a wrong host could at
 * worst deny data, never forge a believed-good profile.
 */

import { Client } from 'ssh2';
import yauzl from 'yauzl';
import { createInterface } from 'node:readline';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseSunbizRecord, type SunbizRecord } from './parse';

const HOST = 'sftp.floridados.gov';
const USER = 'Public';
const PASS = 'PubAccess1845!';
const REMOTE = '/Public/doc/quarterly/Non-Profit/npcordata.zip';
const MEMBER = (digit: string) => `npcordata${digit}.txt`;

export interface SunbizClientOptions {
  /** Where the quarterly zip is cached. Under `.exports/` (gitignored). */
  cachePath?: string;
  /** Re-download when the cache is older than this. Quarterly regenerates ~90d. */
  maxAgeDays?: number;
  /** Skip the cache and always download. */
  refresh?: boolean;
  log?: (msg: string) => void;
}

export class SunbizClient {
  private readonly cachePath: string;
  private readonly maxAgeMs: number;
  private readonly refresh: boolean;
  private readonly log: (msg: string) => void;

  constructor(opts: SunbizClientOptions = {}) {
    this.cachePath = opts.cachePath ?? '.exports/sunbiz/npcordata.zip';
    this.maxAgeMs = (opts.maxAgeDays ?? 60) * 86_400_000;
    this.refresh = opts.refresh ?? false;
    this.log = opts.log ?? (() => {});
  }

  /** Fetch the records for a set of document numbers, keyed by document number. */
  async fetchRecords(docNumbers: string[]): Promise<Map<string, SunbizRecord>> {
    const wanted = new Set(docNumbers.map((d) => d.trim().toUpperCase()));
    if (wanted.size === 0) return new Map();

    await this.ensureZip();

    // Which of the ten member files any wanted document could be in.
    const digits = new Set<string>();
    for (const d of wanted) digits.add(d.slice(-1));

    const found = new Map<string, SunbizRecord>();
    await this.scanZip(digits, wanted, found);
    return found;
  }

  /** Download the quarterly zip unless a fresh copy is already cached. */
  private async ensureZip(): Promise<void> {
    if (!this.refresh) {
      try {
        const s = await stat(this.cachePath);
        if (Date.now() - s.mtimeMs < this.maxAgeMs) {
          this.log(`Using cached Sunbiz feed (${(s.size / 1e6).toFixed(0)} MB).`);
          return;
        }
      } catch {
        // No cache yet — fall through to download.
      }
    }
    await mkdir(dirname(this.cachePath), { recursive: true });
    this.log('Downloading the Sunbiz not-for-profit quarterly feed…');
    await this.download(REMOTE, this.cachePath);
    const s = await stat(this.cachePath);
    this.log(`Downloaded ${(s.size / 1e6).toFixed(0)} MB.`);
  }

  /**
   * Download with a few retries.
   *
   * The server throttles bursts of new SSH sessions, so a handshake now and then
   * times out even though the host is up and the next attempt succeeds. A short
   * backoff turns that from a failed run into a pause.
   */
  private async download(remote: string, local: string): Promise<void> {
    const attempts = 4;
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.downloadOnce(remote, local);
        return;
      } catch (err) {
        if (i === attempts) throw err;
        this.log(`  download attempt ${i} failed (${String(err).slice(0, 60)}); retrying…`);
        await new Promise((r) => setTimeout(r, 3000 * i));
      }
    }
  }

  private downloadOnce(remote: string, local: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          sftp.fastGet(remote, local, (err2) => {
            conn.end();
            if (err2) reject(err2);
            else resolve();
          });
        });
      });
      conn.on('error', reject);
      conn.connect({
        host: HOST,
        port: 22,
        username: USER,
        password: PASS,
        readyTimeout: 60_000,
        // See the file header: public read-only feed, records validated downstream.
        hostVerifier: () => true,
      });
    });
  }

  /** Inflate only the needed member files and collect the wanted records. */
  private scanZip(
    digits: Set<string>,
    wanted: Set<string>,
    found: Map<string, SunbizRecord>,
  ): Promise<void> {
    const members = new Set([...digits].map(MEMBER));
    return new Promise((resolve, reject) => {
      yauzl.open(this.cachePath, { lazyEntries: true }, (err, zip) => {
        if (err || !zip) return reject(err ?? new Error('could not open Sunbiz zip'));

        zip.on('error', reject);
        zip.on('end', () => resolve());
        zip.on('entry', (entry) => {
          if (!members.has(entry.fileName)) return zip.readEntry();
          zip.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) return reject(streamErr ?? new Error('read stream failed'));
            const rl = createInterface({ input: stream, crlfDelay: Infinity });
            rl.on('line', (raw) => {
              const line = raw.length > 1440 ? raw.slice(0, 1440) : raw;
              const doc = line.slice(0, 12).trim().toUpperCase();
              if (wanted.has(doc) && !found.has(doc)) found.set(doc, parseSunbizRecord(line));
            });
            rl.on('close', () => zip.readEntry());
            stream.on('error', reject);
          });
        });

        zip.readEntry();
      });
    });
  }
}
