/**
 * Site passphrase gate.
 *
 * The graph explorer is a multi-second aggregate over a 2 GB database, so it
 * sits behind a shared password while the sponsor summaries under /person stay
 * public. That gate used to live in nginx as a `?p=` match, which meant
 * rotating the password required an SSH session and a reload. Here the hash
 * lives in Postgres so the operator can change it from the header.
 *
 * A session cookie is `<expiry>.<hmac>`, signed with a key derived from both a
 * random server secret and the stored password hash. Deriving from the hash is
 * what makes rotation meaningful: change the password and every outstanding
 * cookie stops verifying, on every browser, at once.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { appSettings } from '@/db/schema';
import { MIN_PASSPHRASE } from './gate.client';

export const GATE_COOKIE = 'pt_gate';

export { MIN_PASSPHRASE };

/** Long enough that a phone used once a week stays signed in. */
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const PASSWORD_KEY = 'gate.password';
const SECRET_KEY = 'gate.secret';

/* ----------------------------------------------------------------- storage */

async function readSetting(key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);
  return row?.value ?? null;
}

async function writeSetting(key: string, value: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/**
 * Insert only if absent, then read back what actually landed. Two requests can
 * race on a cold database; whoever loses must adopt the winner's value or it
 * would sign cookies with a secret nobody else agrees on.
 */
async function seedSetting(key: string, make: () => string): Promise<string> {
  const existing = await readSetting(key);
  if (existing) return existing;
  await db.insert(appSettings).values({ key, value: make() }).onConflictDoNothing();
  return (await readSetting(key)) ?? make();
}

/* ---------------------------------------------------------------- hashing */

function digest(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, 64);
}

export function encodePassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${digest(passphrase, salt).toString('hex')}`;
}

function equals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function matches(stored: string, passphrase: string): boolean {
  const [scheme, saltHex, want] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !want) return false;
  return equals(Buffer.from(want, 'hex'), digest(passphrase, Buffer.from(saltHex, 'hex')));
}

/* ------------------------------------------------------------------ state */

type GateState = { stored: string; secret: string };

/**
 * Read both settings on every request rather than caching them.
 *
 * Middleware is compiled as its own bundle, so a module-level cache there is a
 * different object from the one in a route handler — clearing it after a
 * password change would leave the gate still honouring the old one. One
 * indexed read against a local Postgres is cheaper than that class of bug.
 */
async function loadState(): Promise<GateState> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, [PASSWORD_KEY, SECRET_KEY]));
  const found = new Map(rows.map((r) => [r.key, r.value]));

  return {
    // A fresh database has no password yet. Seed from the environment so the
    // first deploy is reachable rather than locked out.
    stored:
      found.get(PASSWORD_KEY) ??
      (await seedSetting(PASSWORD_KEY, () =>
        encodePassphrase(process.env.GATE_PASSWORD ?? 'liberty'),
      )),
    secret:
      found.get(SECRET_KEY) ??
      (await seedSetting(SECRET_KEY, () => randomBytes(32).toString('hex'))),
  };
}

function signingKey(state: GateState): string {
  return `${state.secret}:${state.stored}`;
}

/* ----------------------------------------------------------------- public */

export async function passphraseIsValid(passphrase: string): Promise<boolean> {
  return matches((await loadState()).stored, passphrase);
}

export async function issueSession(): Promise<{ value: string; maxAge: number }> {
  const state = await loadState();
  const exp = Date.now() + SESSION_MS;
  const mac = createHmac('sha256', signingKey(state)).update(String(exp)).digest('hex');
  return { value: `${exp}.${mac}`, maxAge: Math.floor(SESSION_MS / 1000) };
}

export async function sessionIsValid(value: string | undefined): Promise<boolean> {
  if (!value) return false;
  const dot = value.indexOf('.');
  if (dot < 1) return false;

  const exp = Number(value.slice(0, dot));
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;

  const state = await loadState();
  const want = createHmac('sha256', signingKey(state)).update(String(exp)).digest('hex');
  return equals(Buffer.from(value.slice(dot + 1), 'hex'), Buffer.from(want, 'hex'));
}

export async function setPassphrase(passphrase: string): Promise<void> {
  await writeSetting(PASSWORD_KEY, encodePassphrase(passphrase));
}

/** Cookie options shared by the sign-in and change-password routes. */
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
