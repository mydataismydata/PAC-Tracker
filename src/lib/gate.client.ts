/**
 * The handful of gate constants a browser bundle may see.
 *
 * `@/lib/gate` imports node:crypto and the database client; importing it from a
 * client component would drag both into the bundle.
 */

/** Shortest password accepted when setting one. */
export const MIN_PASSWORD = 10;
