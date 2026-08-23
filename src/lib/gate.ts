/**
 * Accounts for the graph explorer.
 *
 * The sponsor summaries under /person are public records served in
 * milliseconds. A trace is a multi-second aggregate over a 2 GB database, so it
 * sits behind a sign-in.
 *
 * This used to be an htpasswd file read by nginx, which worked except for the
 * one thing people actually need: htpasswd has no self-service, so the operator
 * had to pick everybody's password and hand it over. Accounts live in Postgres
 * now and each person changes their own.
 *
 * A session cookie is `<userId>.<expiry>.<hmac>`, signed with a key derived
 * from a server secret and that user's password hash. Deriving from the hash is
 * what makes a password change meaningful: it invalidates that person's
 * outstanding cookies everywhere, and leaves everyone else's alone.
 */

import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { appSettings, users, type User } from '@/db/schema';
import { MIN_PASSWORD } from './gate.client';

export const GATE_COOKIE = 'pt_session';
export { MIN_PASSWORD };

/** Long enough that a phone used once a week stays signed in. */
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const SECRET_KEY = 'gate.secret';

/* ---------------------------------------------------------------- hashing */

function derive(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, 64);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${derive(password, salt).toString('hex')}`;
}

function equals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function matches(stored: string, password: string): boolean {
  const [scheme, saltHex, want] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !want) return false;
  return equals(Buffer.from(want, 'hex'), derive(password, Buffer.from(saltHex, 'hex')));
}

/**
 * A hash of nothing anyone knows, verified against when the email does not
 * exist. Without it, a missing account answers in a fraction of the time a real
 * one takes, and the difference is a list of who has access.
 */
const ABSENT_USER_HASH = hashPassword(randomBytes(32).toString('hex'));

/* ------------------------------------------------------------------ users */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUser(email: string): Promise<User | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  return row ?? null;
}

export async function listUsers() {
  return db
    .select({
      email: users.email,
      mustChangePassword: users.mustChangePassword,
      createdAt: users.createdAt,
      lastSignInAt: users.lastSignInAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt));
}

export async function countUsers(): Promise<number> {
  return (await db.select({ id: users.id }).from(users).limit(1)).length;
}

/** Create an account with a temporary password the person must replace. */
export async function addUser(email: string, password: string): Promise<void> {
  await db.insert(users).values({
    email: normalizeEmail(email),
    passwordHash: hashPassword(password),
    mustChangePassword: true,
  });
}

/** Operator reset, for someone who has forgotten theirs. */
export async function resetPassword(email: string, password: string): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({
      passwordHash: hashPassword(password),
      mustChangePassword: true,
      updatedAt: new Date(),
    })
    .where(eq(users.email, normalizeEmail(email)))
    .returning({ id: users.id });
  return rows.length > 0;
}

export async function removeUser(email: string): Promise<boolean> {
  const rows = await db
    .delete(users)
    .where(eq(users.email, normalizeEmail(email)))
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Self-service change. Clears the temporary-password flag.
 *
 * Returns the updated row because the caller has to mint a replacement cookie,
 * and the cookie is signed with the *new* hash.
 */
export async function changePassword(userId: string, password: string): Promise<User | null> {
  const [row] = await db
    .update(users)
    .set({
      passwordHash: hashPassword(password),
      mustChangePassword: false,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();
  return row ?? null;
}

/** A password nobody has to invent, for a new account or a reset. */
export function suggestPassword(): string {
  // No l/1/O/0: this gets read off a screen and typed somewhere else.
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 14; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/* --------------------------------------------------------------- sessions */

async function signingSecret(): Promise<string> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, SECRET_KEY))
    .limit(1);
  if (row) return row.value;

  // Two requests can race on a cold database. Insert only if absent, then read
  // back what landed — the loser has to adopt the winner's secret or it would
  // sign cookies nobody else agrees with.
  await db
    .insert(appSettings)
    .values({ key: SECRET_KEY, value: randomBytes(32).toString('hex') })
    .onConflictDoNothing();
  const [seeded] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, SECRET_KEY))
    .limit(1);
  if (!seeded) throw new Error('could not establish a session signing secret');
  return seeded.value;
}

function mac(secret: string, passwordHash: string, payload: string): string {
  return createHmac('sha256', `${secret}:${passwordHash}`).update(payload).digest('hex');
}

export type Session = {
  userId: string;
  email: string;
  mustChangePassword: boolean;
};

export async function issueSession(user: User): Promise<{ value: string; maxAge: number }> {
  const exp = Date.now() + SESSION_MS;
  const payload = `${user.id}.${exp}`;
  const secret = await signingSecret();
  return {
    value: `${payload}.${mac(secret, user.passwordHash, payload)}`,
    maxAge: Math.floor(SESSION_MS / 1000),
  };
}

export async function readSession(cookie: string | undefined): Promise<Session | null> {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 3) return null;

  const [userId, expRaw, given] = parts;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;

  const secret = await signingSecret();
  const want = mac(secret, user.passwordHash, `${userId}.${expRaw}`);
  if (!equals(Buffer.from(given, 'hex'), Buffer.from(want, 'hex'))) return null;

  return {
    userId: user.id,
    email: user.email,
    mustChangePassword: user.mustChangePassword,
  };
}

/**
 * Verify an email and password, returning the account or null.
 *
 * Runs the hash comparison even when the email is unknown, so a wrong address
 * and a wrong password take the same time and neither confirms the other.
 */
export async function verifyCredentials(email: string, password: string): Promise<User | null> {
  const user = await findUser(email);
  const ok = matches(user?.passwordHash ?? ABSENT_USER_HASH, password);
  if (!user || !ok) return null;

  await db.update(users).set({ lastSignInAt: new Date() }).where(eq(users.id, user.id));
  return user;
}

/** Cookie options shared by every route that issues one. */
export function sessionCookie(value: string, maxAge: number) {
  return {
    name: GATE_COOKIE,
    value,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}

export function clearedCookie() {
  return { ...sessionCookie('', 0), maxAge: 0 };
}
