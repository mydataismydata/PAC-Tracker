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
 *   {"op":"split-rows","from":SEL,"where":{"source":"voterfocus-duval",
 *    "raw":"Republican Executive Committee","city":"..."},"to":SEL|{"name":"...","kind":"party"},
 *    "alias":false,"date":"...","note":"..."}
 *   {"op":"set-kind","entity":SEL,"kind":"committee","date":"...","note":"..."}
 *   {"op":"alias","entity":SEL,"alias":"Spelling As Filed","jurisdiction":"FL-DUVAL",
 *    "date":"...","note":"..."}
 *   {"op":"drop-alias","entity":SEL,"alias":"Libertarian Party","date":"...","note":"..."}
 *   {"op":"rename","entity":SEL,"name":"Corrected Spelling","detach":true,
 *    "date":"...","note":"..."}
 *   {"op":"officer-alias","alias":"JONES WILLIAMS","canonical":"JONES WILLIAM",
 *    "date":"...","note":"..."}
 *   {"op":"manual-sql","file":"migrations/manual/x.sql","applied":"...","note":"..."}
 *
 * A selector (SEL) names one entity: {"id":"<uuid>","name":"<expected name>"}.
 * The id is authoritative and the name is a safety assertion — if both are
 * given and the row's name does not match, the entry errors instead of
 * touching the wrong entity. The assertion is met by the display name, any
 * alias the entity carries, or a spelling a `rename` entry in this file gave
 * or took from that id. Either may stand alone: a bare name must match
 * exactly one entity by normalized name; {"acct":"60724"} addresses a
 * committee by its state account number. On a database rebuilt from scratch
 * the ids differ, which is why every selector should carry the name too.
 *
 * `split-rows` reattributes a subset of one entity's rows: those from one
 * feed (`source` is a sources.key), carrying one raw spelling, and/or filed
 * from one city. The target is an existing entity, or a name to converge on
 * or create. The raw spellings of the moved rows become aliases of the
 * target — keyed to the feed's county when the name is a bare local office —
 * and leave the source entity once no row there carries them; `"alias":false`
 * skips that when the spelling is too generic to pin anywhere.
 *
 * `rename` with `"detach":true` also moves the entity's matching identity to
 * the new spelling and drops the old one, so a bare name ("Democratic
 * Executive Committee") stops being a statewide answer. `alias` with a
 * `jurisdiction` code pins the spelling the way a single-county feed keys it;
 * `drop-alias` takes a spelling away again, which a merge can make necessary
 * when the loser carried a bare name ("Libertarian Party") that must not
 * become the survivor's.
 *
 * `manual-sql` entries are the escape hatch for surgery the typed ops cannot
 * express. They are listed, never executed — run them through psql by hand.
 */

import { existsSync } from 'node:fs';
import { db } from '@/db';
import { sql } from 'drizzle-orm';
import { mergeEntities, splitEntity } from '@/lib/ingest/pipeline';
import { isGenericLocalOffice, normalizeName, scopedName, unescapeQuotes } from '@/lib/normalize';
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

/**
 * Every spelling the log itself has given an id, through `rename` entries:
 * the name asserted on the way in and the name given. An entry written before
 * a rename still asserts the old spelling, and a detaching rename removes
 * that spelling from the entity on purpose, so the assertion is satisfied by
 * the log's own record of the rename as well as by the row.
 */
const RENAMED = new Map<string, Set<string>>();
function recordRenames(entries: ReturnType<typeof readCorrections>): void {
  for (const { entry } of entries) {
    if (entry.op !== 'rename' || !entry.entity.id) continue;
    const names = RENAMED.get(entry.entity.id) ?? new Set<string>();
    for (const n of [entry.entity.name, entry.name]) {
      if (n) names.add(normalizeName(unescapeQuotes(n)));
    }
    RENAMED.set(entry.entity.id, names);
  }
}

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
      if (!asserted && sel.name && RENAMED.get(sel.id)?.has(key(sel.name))) {
        asserted = true;
      }
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

async function runSplitRows(e: Extract<Entry, { op: 'split-rows' }>): Promise<Outcome> {
  const from = await resolve(e.from);
  if (from === 'tombstoned') {
    return {
      status: 'error',
      detail: `source entity ${show(e.from)} was merged away — repoint this entry at the survivor`,
    };
  }
  if (!from) return { status: 'error', detail: `source entity ${show(e.from)} not found` };

  const w = e.where ?? {};
  if (!w.source && !w.raw && !w.city) {
    return { status: 'error', detail: 'split-rows needs a source, a raw name, or a city to pick rows by' };
  }
  let sourceId: string | null = null;
  let county: string | null = null;
  if (w.source) {
    const [s] = await db.execute<{ id: string; code: string | null }>(sql`
      SELECT s.id, j.code FROM sources s LEFT JOIN jurisdictions j ON j.id = s.jurisdiction_id
       WHERE s.key = ${w.source}
    `);
    if (!s) return { status: 'error', detail: `no source with key "${w.source}"` };
    sourceId = s.id;
    // Only a single-county feed scopes bare office names; the loader does the
    // same (ingestTransactionRows sets jurisdictionCode for those alone).
    county = s.code && s.code.startsWith('FL-') ? s.code : null;
  }
  const sourceFilter = sourceId ? sql`AND t.source_id = ${sourceId}` : sql``;
  // The city lives on the payer side only, so a city filter picks payer rows.
  const fromSide = sql`t.from_entity_id = ${from.id}
    ${w.raw ? sql`AND upper(t.raw_from_name) = upper(${w.raw})` : sql``}
    ${w.city ? sql`AND upper(t.from_city) = upper(${w.city})` : sql``}`;
  const toSide = w.city
    ? sql`false`
    : sql`t.to_entity_id = ${from.id}
    ${w.raw ? sql`AND upper(t.raw_to_name) = upper(${w.raw})` : sql``}`;
  const rows = await db.execute<{ id: string; raw: string | null; amount: string }>(sql`
    SELECT t.id,
           CASE WHEN t.from_entity_id = ${from.id} THEN t.raw_from_name ELSE t.raw_to_name END AS raw,
           t.amount
      FROM transactions t
     WHERE ((${fromSide}) OR (${toSide})) ${sourceFilter}
  `);
  const picked = [
    w.source ? `from ${w.source}` : null,
    w.raw ? `filed as "${w.raw}"` : null,
    w.city ? `from ${w.city}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  if (rows.length === 0) {
    return { status: 'applied', detail: `"${from.name}" has no rows left ${picked}` };
  }
  const dollars = rows.reduce((a, r) => a + Number(r.amount), 0);

  // The target: an existing entity by id, or a name to converge on or create.
  let target: EntityRow | null = null;
  if (e.to.id) {
    const r = await resolve({ id: e.to.id, name: e.to.name });
    if (r === 'tombstoned') {
      return { status: 'error', detail: `target ${show(e.to)} was merged away — repoint this entry` };
    }
    if (!r) return { status: 'error', detail: `target ${show(e.to)} not found` };
    target = r;
  } else if (e.to.name) {
    const r = await resolve({ name: e.to.name });
    if (r && r !== 'tombstoned') target = r;
    else if (!e.to.kind) {
      return { status: 'error', detail: `"${e.to.name}" does not exist yet; give it a kind to create it` };
    }
  } else {
    return { status: 'error', detail: 'split-rows needs a target: {id,name} or {name,kind}' };
  }
  if (target && target.id === from.id) {
    return { status: 'error', detail: `target of split-rows is the source itself ("${from.name}")` };
  }
  const verb = target ? `onto "${target.name}"` : `onto new entity "${e.to.name}" (${e.to.kind})`;
  if (!APPLY) {
    return {
      status: 'pending',
      detail: `would move ${rows.length} row(s) ($${dollars.toFixed(2)}) ${picked} off "${from.name}" ${verb}`,
    };
  }

  const ids = rows.map((r) => r.id);
  let targetId: string;
  if (target) {
    targetId = target.id;
    await db.execute(sql`
      UPDATE transactions
         SET from_entity_id = CASE WHEN from_entity_id = ${from.id} THEN ${targetId} ELSE from_entity_id END,
             to_entity_id   = CASE WHEN to_entity_id   = ${from.id} THEN ${targetId} ELSE to_entity_id END
       WHERE id = ANY(${sql.param(ids)}::uuid[])
    `);
  } else {
    const created = await splitEntity(db, from.id, ids, {
      name: e.to.name as string,
      kind: e.to.kind as NonNullable<typeof e.to.kind>,
    });
    targetId = created.id;
  }

  // The spellings that travelled now resolve to the target, keyed the way the
  // feed keys them, and stop resolving to the source once nothing there uses
  // them. Registry-origin aliases on the source are the county index's own
  // record and stay.
  if (e.alias !== false) {
    const raws = [...new Set(rows.map((r) => r.raw).filter((r): r is string => !!r))];
    for (const raw of raws) {
      const norm = normalizeName(raw);
      if (!norm) continue;
      const key = county && isGenericLocalOffice(norm) ? scopedName(norm, county) : norm;
      await db.execute(sql`
        INSERT INTO entity_aliases (entity_id, alias, normalized_alias, origin, confidence)
        VALUES (${targetId}, ${raw}, ${key}, 'manual', 1)
        ON CONFLICT (entity_id, normalized_alias) DO NOTHING
      `);
      const [left] = await db.execute<{ x: number }>(sql`
        SELECT 1 AS x FROM transactions t
         WHERE ((t.from_entity_id = ${from.id} AND upper(t.raw_from_name) = upper(${raw}))
             OR (t.to_entity_id = ${from.id} AND upper(t.raw_to_name) = upper(${raw})))
           ${sourceFilter}
         LIMIT 1
      `);
      if (!left) {
        await db.execute(sql`
          DELETE FROM entity_aliases
           WHERE entity_id = ${from.id}
             AND normalized_alias = ANY(${sql.param([norm, key])}::text[])
             AND origin <> 'registry'
        `);
      }
    }
  }
  return {
    status: 'pending',
    detail: `moved ${rows.length} row(s) ($${dollars.toFixed(2)}) ${picked} off "${from.name}" ${verb}`,
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
  if (e.detach) {
    // The identity moves with the name: the old spelling was a bare office
    // that belongs to no county in particular, and must not keep answering
    // for this one. Feed-scoped aliases ("NAME @FL-STJOHNS") are untouched.
    const [cur] = await db.execute<{ normalized_name: string }>(
      sql`SELECT normalized_name FROM entities WHERE id = ${row.id}`,
    );
    await db.execute(sql`
      UPDATE entities SET name = ${e.name}, normalized_name = ${normalizeName(e.name)}
       WHERE id = ${row.id}
    `);
    await db.execute(sql`
      DELETE FROM entity_aliases WHERE entity_id = ${row.id} AND normalized_alias = ${cur.normalized_name}
    `);
    return { status: 'pending', detail: `renamed "${row.name}" -> "${e.name}" and detached the old spelling` };
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
  if (e.jurisdiction) {
    const [j] = await db.execute<{ id: string }>(
      sql`SELECT id FROM jurisdictions WHERE code = ${e.jurisdiction}`,
    );
    if (!j) return { status: 'error', detail: `no jurisdiction with code "${e.jurisdiction}"` };
  }
  const norm = e.jurisdiction
    ? scopedName(normalizeName(e.alias), e.jurisdiction)
    : normalizeName(e.alias);
  const shown = e.jurisdiction ? `"${e.alias}" @${e.jurisdiction}` : `"${e.alias}"`;
  const [hit] = await db.execute<{ id: string }>(sql`
    SELECT id FROM entity_aliases WHERE entity_id = ${row.id} AND normalized_alias = ${norm}
  `);
  if (hit) return { status: 'applied', detail: `"${row.name}" already carries ${shown}` };
  if (!APPLY) {
    return { status: 'pending', detail: `would pin ${shown} onto "${row.name}"` };
  }
  await db.execute(sql`
    INSERT INTO entity_aliases (entity_id, alias, normalized_alias, origin, confidence)
    VALUES (${row.id}, ${e.alias}, ${norm}, 'manual', 1)
    ON CONFLICT (entity_id, normalized_alias) DO NOTHING
  `);
  return { status: 'pending', detail: `pinned ${shown} onto "${row.name}"` };
}

async function runDropAlias(e: Extract<Entry, { op: 'drop-alias' }>): Promise<Outcome> {
  const row = await resolve(e.entity);
  if (row === 'tombstoned') {
    return { status: 'applied', detail: `${show(e.entity)} was merged away; nothing to drop` };
  }
  if (!row) {
    return { status: 'error', detail: `entity ${show(e.entity)} not found` };
  }
  const norm = e.jurisdiction
    ? scopedName(normalizeName(e.alias), e.jurisdiction)
    : normalizeName(e.alias);
  const shown = e.jurisdiction ? `"${e.alias}" @${e.jurisdiction}` : `"${e.alias}"`;
  const hits = await db.execute<{ id: string }>(sql`
    SELECT id FROM entity_aliases WHERE entity_id = ${row.id} AND normalized_alias = ${norm}
  `);
  if (hits.length === 0) {
    return { status: 'applied', detail: `"${row.name}" does not carry ${shown}` };
  }
  if (!APPLY) {
    return { status: 'pending', detail: `would take ${shown} off "${row.name}"` };
  }
  await db.execute(sql`
    DELETE FROM entity_aliases WHERE entity_id = ${row.id} AND normalized_alias = ${norm}
  `);
  return { status: 'pending', detail: `took ${shown} off "${row.name}"` };
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

  recordRenames(entries);
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
        : entry.op === 'split-rows' ? await runSplitRows(entry)
        : entry.op === 'set-kind' ? await runSetKind(entry)
        : entry.op === 'rename' ? await runRename(entry)
        : entry.op === 'alias' ? await runAlias(entry)
        : entry.op === 'drop-alias' ? await runDropAlias(entry)
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
