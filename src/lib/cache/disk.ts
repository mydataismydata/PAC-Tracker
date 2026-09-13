/**
 * Files that outlive the process, for answers that are expensive to make and
 * cheap to keep.
 *
 * A container restart is a new process with an empty `/tmp`. Everything held
 * in memory is gone, and everything written under the container's own
 * filesystem goes with it. So a deploy that changed one line of markup used
 * to throw away a week of traces and pictures, and the first reader of every
 * page after it paid for them again.
 *
 * This puts them somewhere that stays: `PT_CACHE_DIR`, which the compose file
 * points at a named volume. Without the variable it falls back to the temp
 * directory, which is right for development and wrong for nothing.
 *
 * Every entry is a file named by a hash of its key, under a namespace
 * directory. What goes in the key is the caller's business; the trace cache
 * and the snapshot cache both fold in a stamp of the data behind the answer,
 * so a correction landing makes old files unreachable rather than wrong. The
 * sweep then removes them by age, oldest-read first when the namespace is
 * over its size.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.PT_CACHE_DIR || path.join(os.tmpdir(), 'pactracker-cache');

const SWEEP_EVERY_MS = 10 * 60 * 1000;
const sweptAt = new Map<string, number>();

function file(ns: string, key: string, ext: string): string {
  return path.join(ROOT, ns, `${key}.${ext}`);
}

/** The bytes under this key, or null. A read counts as use. */
export async function read(ns: string, key: string, ext: string): Promise<Buffer | null> {
  const f = file(ns, key, ext);
  try {
    const held = await fs.readFile(f);
    const now = new Date();
    void fs.utimes(f, now, now).catch(() => undefined);
    return held;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Keep these bytes under this key.
 *
 * Written beside the final name and renamed into place, so a reader never
 * sees half a file. A failure — a full disk, a read-only mount — costs a
 * recompute next time and nothing now, so it is swallowed here.
 */
export async function write(
  ns: string,
  key: string,
  ext: string,
  bytes: Uint8Array | string,
  limits: { ttlMs: number; maxBytes: number },
): Promise<void> {
  const f = file(ns, key, ext);
  try {
    await fs.mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, f);
  } catch {
    return;
  }
  void sweep(ns, limits);
}

/** Drop what is past its age, then the least recently read until under the cap. */
async function sweep(ns: string, limits: { ttlMs: number; maxBytes: number }): Promise<void> {
  const now = Date.now();
  if (now - (sweptAt.get(ns) ?? 0) < SWEEP_EVERY_MS) return;
  sweptAt.set(ns, now);

  const dir = path.join(ROOT, ns);
  try {
    const names = await fs.readdir(dir);
    const files: { f: string; size: number; used: number }[] = [];
    for (const name of names) {
      const f = path.join(dir, name);
      const st = await fs.stat(f).catch(() => null);
      if (!st?.isFile()) continue;
      const stale =
        now - st.mtimeMs > limits.ttlMs || (name.endsWith('.tmp') && now - st.mtimeMs > 60_000);
      if (stale) {
        await fs.unlink(f).catch(() => undefined);
        continue;
      }
      files.push({ f, size: st.size, used: st.mtimeMs });
    }

    let total = files.reduce((a, x) => a + x.size, 0);
    files.sort((a, b) => a.used - b.used);
    for (const x of files) {
      if (total <= limits.maxBytes) break;
      await fs.unlink(x.f).catch(() => undefined);
      total -= x.size;
    }
  } catch {
    // The directory may not exist yet, or may have gone. Either is fine.
  }
}
