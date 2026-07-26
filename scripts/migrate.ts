/**
 * Apply pending Drizzle migrations, then the extensions and indexes that the
 * schema builder cannot express.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url =
  process.env.DATABASE_URL ?? 'postgres://pactracker:pactracker@localhost:5439/pactracker';

async function main() {
  // `max: 1` is required — the migrator must run statements in order on one
  // connection.
  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);

  // pg_trgm powers fuzzy contributor-name matching and must exist before the
  // GIN indexes below are created.
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;

  console.log('applying migrations…');
  await migrate(db, { migrationsFolder: './drizzle' });

  console.log('creating trigram indexes…');
  await sql`
    CREATE INDEX IF NOT EXISTS entities_normalized_name_trgm
      ON entities USING gin (normalized_name gin_trgm_ops)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS entity_aliases_normalized_trgm
      ON entity_aliases USING gin (normalized_alias gin_trgm_ops)
  `;
  // Contributor strings are searched by prefix when reconciling truncated names.
  await sql`
    CREATE INDEX IF NOT EXISTS entities_normalized_name_prefix
      ON entities (normalized_name text_pattern_ops)
  `;

  console.log('done.');
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
