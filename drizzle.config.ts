import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://pactracker:pactracker@localhost:5439/pactracker',
  },
  strict: true,
  verbose: true,
} satisfies Config;
