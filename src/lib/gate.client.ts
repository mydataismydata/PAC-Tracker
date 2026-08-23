/**
 * The handful of gate constants a browser bundle may see.
 *
 * `@/lib/gate` imports node:crypto and the database client; importing it from a
 * client component would drag both into the bundle.
 */

/** Shortest passphrase accepted when setting a new one. */
export const MIN_PASSPHRASE = 6;
