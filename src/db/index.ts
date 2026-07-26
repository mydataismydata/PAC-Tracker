import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString =
  process.env.DATABASE_URL ??
  'postgres://pactracker:pactracker@localhost:5439/pactracker';

/**
 * Next.js dev mode re-evaluates modules on every hot reload. Without caching the
 * client on globalThis each reload opens a fresh pool and the connection count
 * climbs until Postgres refuses new sessions.
 */
const globalForDb = globalThis as unknown as {
  pacTrackerClient?: ReturnType<typeof postgres>;
};

const client =
  globalForDb.pacTrackerClient ??
  postgres(connectionString, {
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idle_timeout: 20,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pacTrackerClient = client;
}

export const db = drizzle(client, { schema });
export { client, schema };
