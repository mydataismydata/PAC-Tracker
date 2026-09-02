/**
 * The corrections log, read from the ingest side.
 *
 * `corrections/corrections.jsonl` is the durable record of every judgement a
 * person has made about this data. `scripts/corrections.ts` applies it; this
 * module only reads it, so that a mechanical pass can honour it — the
 * contributor-kind backfill never overrides a kind a person set here.
 *
 * One JSON object per line, oldest first; `#` lines and blank lines are
 * ignored. The entry shapes are documented in the header of
 * `scripts/corrections.ts` and in docs-local/data-structure.md.
 */

import { existsSync, readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { normalizeName } from './normalize';

type Db = PostgresJsDatabase<typeof schema>;

export const CORRECTIONS_FILE = 'corrections/corrections.jsonl';

/**
 * Names one entity. The id is authoritative and the name is a safety
 * assertion; either may stand alone. `acct` addresses a committee by its
 * state account number.
 */
export interface Selector {
  id?: string;
  name?: string;
  acct?: string;
}

export type EntityKind = 'individual' | 'organization' | 'committee' | 'candidate' | 'party';

export type CorrectionEntry =
  | { op: 'merge'; keep: Selector; lose: Selector[]; date?: string; note: string }
  | {
      op: 'split';
      from: Selector;
      city: string;
      name: string;
      kind?: EntityKind;
      occupation?: string;
      date?: string;
      note: string;
    }
  | {
      /**
       * Move a subset of one entity's rows onto another, picked by the feed
       * they came from, the raw name on the row, and/or the payer's city.
       * `to` is an existing entity ({id,name}) or one to converge on or
       * create by name ({name,kind}). Aliases follow the rows unless
       * `alias` is false.
       */
      op: 'split-rows';
      from: Selector;
      where: { source?: string; raw?: string; city?: string };
      to: Selector & { kind?: EntityKind };
      alias?: boolean;
      date?: string;
      note: string;
    }
  | { op: 'set-kind'; entity: Selector; kind: EntityKind; date?: string; note: string }
  | {
      /**
       * `detach` also moves the matching identity: the normalized name
       * follows the new spelling and the old one stops resolving here. For a
       * bare name that belongs to no county in particular.
       */
      op: 'rename';
      entity: Selector;
      name: string;
      detach?: boolean;
      date?: string;
      note: string;
    }
  | {
      /** `jurisdiction` keys the alias the way a single-county feed does (`NAME @FL-DUVAL`). */
      op: 'alias';
      entity: Selector;
      alias: string;
      jurisdiction?: string;
      date?: string;
      note: string;
    }
  | {
      /** Stop a spelling resolving to this entity; `jurisdiction` keys it like `alias` does. */
      op: 'drop-alias';
      entity: Selector;
      alias: string;
      jurisdiction?: string;
      date?: string;
      note: string;
    }
  | { op: 'officer-alias'; alias: string; canonical: string; date?: string; note: string }
  | { op: 'manual-sql'; file: string; applied?: string; date?: string; note: string };

export interface CorrectionLine {
  line: number;
  entry: CorrectionEntry;
}

/** Parse the log. A missing file is an empty log; a bad line is an error naming it. */
export function readCorrections(path = CORRECTIONS_FILE): CorrectionLine[] {
  if (!existsSync(path)) return [];
  const out: CorrectionLine[] = [];
  for (const [i, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    let entry: CorrectionEntry;
    try {
      entry = JSON.parse(t) as CorrectionEntry;
    } catch {
      throw new Error(`${path}:${i + 1} is not valid JSON`);
    }
    out.push({ line: i + 1, entry });
  }
  return out;
}

/**
 * Every entity whose kind a person has set with a `set-kind` entry.
 *
 * Resolved by id first, then by normalized name, which is what keeps the
 * lock meaningful on a database rebuilt since the entry was written. An
 * entry that resolves to nothing is simply absent here; the runner is the
 * place that reports it.
 */
export async function manualKindEntityIds(db: Db, path = CORRECTIONS_FILE): Promise<Set<string>> {
  const selectors = readCorrections(path)
    .map((l) => l.entry)
    .filter((e): e is Extract<CorrectionEntry, { op: 'set-kind' }> => e.op === 'set-kind')
    .map((e) => e.entity);
  const ids = new Set<string>();
  const byId = selectors.map((s) => s.id).filter((id): id is string => !!id);
  if (byId.length > 0) {
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM entities WHERE id = ANY(${sql.param(byId)}::uuid[])`,
    );
    for (const r of rows) ids.add(r.id);
  }
  const names = selectors
    .filter((s) => s.name && !(s.id && ids.has(s.id)))
    .map((s) => normalizeName(s.name as string));
  if (names.length > 0) {
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM entities WHERE normalized_name = ANY(${sql.param(names)}::text[])`,
    );
    for (const r of rows) ids.add(r.id);
  }
  return ids;
}
