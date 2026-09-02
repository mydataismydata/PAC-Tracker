/**
 * Apply hand-confirmed data corrections from `corrections/corrections.jsonl`.
 *
 * Usage:
 *   pnpm corrections              # dry run — say what each entry would do
 *   pnpm corrections --apply     # apply pending entries, in file order
 *   pnpm corrections --file=...  # read a different corrections file
 *
 * The file is the durable record of every judgement a human has made about
 * this data: one JSON object per line, oldest first, `#` lines and blank
 * lines ignored. Every operation is idempotent, so the whole file can be
 * replayed against a freshly re-ingested database and it converges — an entry
 * whose work is already done reports "already applied" and touches nothing.
 *
 * Corrections run HERE, never on the deployment box. The triggers on
 * `entities` and `transactions` stamp `updated_at` on anything an entry
 * changes, merges write `entity_tombstones`, and `sync-to-vps.sh` ships all
 * of it. After applying: `pnpm ingest rebuild`, then sync.
 *
 * Entry shapes (see docs-local/data-structure.md for the full contract):
 *
 *   {"op":"merge","keep":SEL,"lose":[SEL,...],"date":"...","note":"..."}
 *   {"op":"split","from":SEL,"city":"GOLDEN BEACH","name":"New Name",
 *    "kind":"individual","occupation":"...","date":"...","note":"..."}
 *   {"op":"set-kind","entity":SEL,"kind":"committee","date":"...","note":"..."}
 *   {"op":"alias","entity":SEL,"alias":"Spelling As Filed","date":"...","note":"..."}
 *   {"op":"rename","entity":SEL,"name":"Corrected Spelling","date":"...","note":"..."}
 *   {"op":"officer-alias","alias":"JONES WILLIAMS","canonical":"JONES WILLIAM",
 *    "date":"...","note":"..."}
 *   {"op":"manual-sql","file":"migrations/manual/x.sql","applied":"...","note":"..."}
 *
 * A selector (SEL) names one entity: {"id":"<uuid>","name":"<expected name>"}.
 * The id is authoritative and the name is a safety assertion — if both are
 * given and the row's name does not match, the entry errors instead of
 * touching the wrong entity. Either may stand alone: a bare name must match
 * exactly one entity by normalized name; {"acct":"60724"} addresses a
 * committee by its state account number. On a database rebuilt from scratch
 * the ids differ, which is why every selector should carry the name too.
 *
 * `manual-sql` entries are the escape hatch for surgery the typed ops cannot
 * express (reattributing a subset of rows by raw name and source). They are
 * listed, never executed — run them through psql by hand.
 */

import { existsSync } from 'node:fs';
import { db } from '@/db';
import { sql } from 'drizzle-orm';
import { mergeEntities, splitEntity } from '@/lib/ingest/pipeline';
import { normalizeName, unescapeQuotes } from '@/lib/normalize';
import {
  CORRECTIONS_FILE,
  readCorrections,
  type CorrectionEntry as Entry,
  type Selector,
} from '@/lib/corrections';

type Status = 'pending' | 'applied' | 'manual' | 'error';
interface Outcome {
  status: Status;
  detail: string;
}

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const FILE =
  argv.find((a) => a.startsWith('--file='))?.slice('--file='.length) ??
  CORRECTIONS_FILE;

type EntityRow = {
  id: string;
  name: string;
  kind: string;
};

/** Resolve a selector to a live entity, 'tombstoned', or null (absent). */
async function resolve(
  sel: Selector,
  alsoAccept?: string,
): Promise<EntityRow | 'tombstoned' | null> {
  if (sel.id) {
    const [row] = await db.execute<EntityRow>(
      sql`SELECT id, name, kind::text AS kind FROM entities WHERE id = ${sel.id}`,
    );
    if (row) {
      // The assertion passes on the display name, on a spelling the entry
      // itself introduces (a rename's new name), or on any alias the entity
      // carries — the filed spelling, or a display name a backfill has since
      // replaced. The export's backslash before a quote is ignored on both
      // sides, so an entry written before `backfill-quotes` ran still holds.
      const key = (x: string) => normalizeName(unescapeQuotes(x));
      const have = key(row.name);
      let asserted =
        !sel.name || key(sel.name) === have || (alsoAccept !== undefined && key(alsoAccept) === have);
      if (!asserted && sel.name) {
        const [alias] = await db.execute<{ id: string }>(sql`
          SELECT id FROM entity_aliases
           WHERE entity_id = ${sel.id} AND normalized_alias = ${key(sel.name)}
           LIMIT 1
        `);
        asserted = !!alias;
      }
      if (!asserted) {
        throw new Error(
          `id ${sel.id} is "${row.name}", not "${sel.name}" — refusing to touch it`,
        );
      }
      return row;
    }
    const [tomb] = await db.execute<{ id: string }>(
      sql`SELECT id FROM entity_tombstones WHERE id = ${sel.id}`,
    );
    if (tomb) return 'tombstoned';
    // Fall through: on a rebuilt database the id is gone but the name may hold.
  }

  if (sel.acct) {
    const rows = await db.execute<EntityRow>(sql`
      SELECT e.id, e.name, e.kind::text AS kind
        FROM committee_registrations r JOIN entities e ON e.id = r.entity_id
       WHERE r.external_id = ${sel.acct} AND r.is_current
    `);
    if (rows.length > 1) throw new Error(`account ${sel.acct} matches ${rows.length} entities`);
    return rows[0] ?? null;
  }

  if (sel.name) {
    const rows = await db.execute<EntityRow>(sql`
      SELECT id, name, kind::text AS kind FROM entities
       WHERE normalized_name = ${normalizeName(sel.name)}
    `);
    if (rows.length > 1) {
      throw new Error(
        `"${sel.name}" matches ${rows.length} entities (${rows.map((r) => r.id).join(', ')}) — add an id`,
      );
    }
    return rows[0] ?? null;
  }

  throw new Error(`selector needs an id, a name, or an acct: ${JSON.stringify(sel)}`);
}

const show = (s: Selector) => s.name ?? s.acct ?? s.id ?? '?';

async function runMerge(e: Extract<Entry, { op: 'merge' }>): Promise<Outcome> {
  const keep = await resolve(e.keep);
  if (keep === 'tombstoned') {
    return {
      status: 'error',
      detail: `keep entity ${show(e.keep)} was itself merged away — repoint this entry`,
    };
  }
  if (!keep) return { status: 'error', detail: `keep entity ${show(e.keep)} not found` };

  const liveLosers: EntityRow[] = [];
  for (const l of e.lose) {
    const r = await resolve(l);
    if (r !== 'tombstoned' && r !== null) {
      if (r.id === keep.id) continue; // selector now lands on the survivor
      liveLosers.push(r);
    }
  }
  if (liveLosers.length === 0) {
    return { status: 'applied', detail: `nothing left to merge into "${keep.name}"` };
  }
  if (!APPLY) {
    return {
      status: 'pending',
      detail: `would fold ${liveLosers.map((l) => `"${l.name}"`).join(', ')} into "${keep.name}"`,
    };
  }
  await mergeEntities(db, keep.id, liveLosers.map((l) => l.id));
  return { status: 'pending', detail: `merged ${liveLosers.length} into "${keep.name}"` };
}

async function runSplit(e: Extract<Entry, { op: 'split' }>): Promise<Outcome> {
  const from = await resolve(e.from);
  if (from === 'tombstoned' || !from) {
    return { status: 'error', detail: `source entity ${show(e.from)} not found` };
  }

  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM transactions
     WHERE from_entity_id = ${from.id} AND upper(from_city) = upper(${e.city})
  `);
  if (rows.length === 0) {
    return { status: 'applied', detail: `"${from.name}" has no rows filed from ${e.city}` };
  }

  // Converge on an existing target, so replaying never mints a second copy.
  const existing = await db.execute<EntityRow>(sql`
    SELECT id, name, kind::text AS kind FROM entities
     WHERE normalized_name = ${normalizeName(e.name)} AND upper(city) = upper(${e.city})
  `);
  const verb = existing.length > 0 ? `move onto existing "${existing[0].name}"` : `create "${e.name}"`;
  if (!APPLY) {
    return {
      status: 'pending',
      detail: `would take ${rows.length} row(s) filed from ${e.city} off "${from.name}" and ${verb}`,
    };
  }

  if (existing.length > 0) {
    await db.execute(sql`
      UPDATE transactions SET from_entity_id = ${existing[0].id}
       WHERE id = ANY(${sql.param(rows.map((r) => r.id))}::uuid[])
    `);
    return { status: 'pending', detail: `moved ${rows.length} row(s) onto "${existing[0].name}"` };
  }

  const created = await splitEntity(db, from.id, rows.map((r) => r.id), {
    name: e.name,
    kind: e.kind ?? 'individual',
    city: e.city,
    occupation: e.occupation ?? null,
  });
  return {
    status: 'pending',
    detail: `moved ${created.moved} row(s) onto new entity ${created.id} ("${e.name}")`,
  };
}

async function runSetKind(e: Extract<Entry, { op: 'set-kind' }>): Promise<Outcome> {
  const row = await resolve(e.entity);
  if (row === 'tombstoned') {
    // Merged into another entity since this was written: the judgement
    // belongs to a row that no longer exists, so there is nothing left to do.
    return { status: 'applied', detail: `${show(e.entity)} was merged away; nothing to set` };
  }
  if (!row) {
    return { status: 'error', detail: `entity ${show(e.entity)} not found` };
  }
  if (row.kind === e.kind) {
    return { status: 'applied', detail: `"${row.name}" is already ${e.kind}` };
  }
  if (!APPLY) {
    return { status: 'pending', detail: `would re-kind "${row.name}" ${row.kind} -> ${e.kind}` };
  }
  // A kind that can receive-and-forward money should be crawlable too.
  const traversable = ['committee', 'party', 'candidate'].includes(e.kind);
  await db.execute(sql`
    UPDATE entities
       SET kind = ${e.kind}::entity_kind,
           is_traversable = is_traversable OR ${traversable}
     WHERE id = ${row.id}
  `);
  return { status: 'pending', detail: `re-kinded "${row.name}" ${row.kind} -> ${e.kind}` };
}

async function runRename(e: Extract<Entry, { op: 'rename' }>): Promise<Outcome> {
  // The assertion accepts the new spelling too, so a replay after the rename
  // finds the entity instead of refusing to touch it.
  const row = await resolve(e.entity, e.name);
  if (row === 'tombstoned') {
    // Merged into another entity since this was written: the judgement
    // belongs to a row that no longer exists, so there is nothing left to do.
    return { status: 'applied', detail: `${show(e.entity)} was merged away; nothing to rename` };
  }
  if (!row) {
    return { status: 'error', detail: `entity ${show(e.entity)} not found` };
  }
  if (row.name === e.name) {
    return { status: 'applied', detail: `"${row.name}" already reads so` };
  }
  if (!APPLY) {
    return { status: 'pending', detail: `would rename "${row.name}" -> "${e.name}"` };
  }
  await db.execute(sql`UPDATE entities SET name = ${e.name} WHERE id = ${row.id}`);
  // The corrected spelling resolves here from now on. The filed spelling
  // already does, through normalized_name and the observed alias, and both
  // are left as they are.
  await db.execute(sql`
    INSERT INTO entity_aliases (entity_id, alias, normalized_alias, origin, confidence)
    VALUES (${row.id}, ${e.name}, ${normalizeName(e.name)}, 'manual', 1)
    ON CONFLICT (entity_id, normalized_alias) DO NOTHING
  `);
  return { status: 'pending', detail: `renamed "${row.name}" -> "${e.name}"` };
}

async function runAlias(e: Extract<Entry, { op: 'alias' }>): Promise<Outcome> {
  const row = await resolve(e.entity);
  if (row === 'tombstoned') {
    // Merged into another entity since this was written: the judgement
    // belongs to a row that no longer exists, so there is nothing left to do.
    return { status: 'applied', detail: `${show(e.entity)} was merged away; nothing to pin` };
  }
  if (!row) {
    return { status: 'error', detail: `entity ${show(e.entity)} not found` };
  }
  const norm = normalizeName(e.alias);
  const [hit] = await db.execute<{ id: string }>(sql`
    SELECT id FROM entity_aliases WHERE entity_id = ${row.id} AND normalized_alias = ${norm}
  `);
  if (hit) return { status: 'applied', detail: `"${row.name}" already carries "${e.alias}"` };
  if (!APPLY) {
    return { status: 'pending', detail: `would pin "${e.alias}" onto "${row.name}"` };
  }
  await db.execute(sql`
    INSERT INTO entity_aliases (entity_id, alias, normalized_alias, origin, confidence)
    VALUES (${row.id}, ${e.alias}, ${norm}, 'manual', 1)
    ON CONFLICT (entity_id, normalized_alias) DO NOTHING
  `);
  return { status: 'pending', detail: `pinned "${e.alias}" onto "${row.name}"` };
}

async function runOfficerAlias(e: Extract<Entry, { op: 'officer-alias' }>): Promise<Outcome> {
  const [hit] = await db.execute<{ alias: string }>(sql`
    SELECT alias FROM officer_aliases WHERE alias = ${e.alias}
  `);
  if (hit) return { status: 'applied', detail: `${e.alias} -> ${e.canonical} is on record` };
  if (!APPLY) {
    return { status: 'pending', detail: `would key ${e.alias} as ${e.canonical}` };
  }
  await db.execute(sql`
    INSERT INTO officer_aliases (alias, canonical, note)
    VALUES (${e.alias}, ${e.canonical}, ${e.note})
    ON CONFLICT (alias) DO NOTHING
  `);
  // Retro-apply to rows already loaded; re-ingest reaches the same result
  // through the alias lookup in ingestCommitteeRegistrations. A committee that
  // names the person under both spellings in one role would collide on the
  // partial unique index, so the misspelt duplicate is dropped, not updated.
  await db.execute(sql`
    DELETE FROM committee_officers dup
     USING committee_officers keep
     WHERE dup.normalized_name = ${e.alias}
       AND keep.normalized_name = ${e.canonical}
       AND keep.entity_id = dup.entity_id
       AND keep.role = dup.role
       AND keep.source_id IS NOT DISTINCT FROM dup.source_id
       AND keep.is_current AND dup.is_current
  `);
  const updated = await db.execute(sql`
    UPDATE committee_officers
       SET normalized_name = ${e.canonical}, updated_at = now()
     WHERE normalized_name = ${e.alias}
  `);
  return {
    status: 'pending',
    detail: `keyed ${e.alias} as ${e.canonical}; rekeyed ${updated.count ?? 0} officer row(s)`,
  };
}

function runManualSql(e: Extract<Entry, { op: 'manual-sql' }>): Outcome {
  if (!existsSync(e.file)) {
    return { status: 'error', detail: `${e.file} does not exist` };
  }
  return {
    status: 'manual',
    detail: `${e.file}${e.applied ? ` (applied ${e.applied})` : ''} — run via psql by hand, never here`,
  };
}

async function main() {
  let entries: ReturnType<typeof readCorrections>;
  try {
    entries = readCorrections(FILE);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  console.log(`${FILE}: ${entries.length} entries${APPLY ? '' : ' (dry run — pass --apply to act)'}\n`);

  let changed = 0;
  let errors = 0;
  for (const { line, entry } of entries) {
    if (!('note' in entry) || !entry.note) {
      console.error(`  line ${line}: every entry needs a note saying why`);
      errors++;
      continue;
    }
    let out: Outcome;
    try {
      out =
        entry.op === 'merge' ? await runMerge(entry)
        : entry.op === 'split' ? await runSplit(entry)
        : entry.op === 'set-kind' ? await runSetKind(entry)
        : entry.op === 'rename' ? await runRename(entry)
        : entry.op === 'alias' ? await runAlias(entry)
        : entry.op === 'officer-alias' ? await runOfficerAlias(entry)
        : entry.op === 'manual-sql' ? runManualSql(entry)
        : { status: 'error' as const, detail: `unknown op "${(entry as { op: string }).op}"` };
    } catch (err) {
      out = { status: 'error', detail: String(err instanceof Error ? err.message : err) };
    }
    const mark =
      out.status === 'applied' ? 'ok  '
      : out.status === 'manual' ? 'man '
      : out.status === 'error' ? 'ERR '
      : APPLY ? 'DID '
      : 'todo';
    console.log(`  [${mark}] line ${line} ${entry.op}: ${out.detail}`);
    if (out.status === 'error') errors++;
    if (out.status === 'pending') changed++;
  }

  if (APPLY && changed > 0) {
    console.log(
      `\n${changed} entr${changed === 1 ? 'y' : 'ies'} applied. Now:\n` +
        `  pnpm ingest rebuild        # re-derive rollups and totals\n` +
        `  ./scripts/sync-to-vps.sh   # ship the corrected rows and tombstones`,
    );
  } else if (!APPLY && changed > 0) {
    console.log(`\n${changed} entr${changed === 1 ? 'y' : 'ies'} pending. Re-run with --apply.`);
  } else if (errors === 0) {
    console.log('\nEverything in the file is already applied.');
  }
  process.exit(errors > 0 ? 1 : 0);
}

main();
