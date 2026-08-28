/**
 * "I don't have an account."
 *
 * Accounts are issued by hand, so this does not create one. It carries the ask
 * to whoever runs the instance, who decides. Public by necessity — the person
 * sending it cannot sign in — which makes it the one endpoint here that a
 * stranger can use to make the server do work, so it is throttled hard and
 * says as little as possible.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { mailConfigured, sendAccessRequest } from '@/lib/mail';

export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z
    .string()
    .trim()
    .max(200)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'That does not look like an email address.')
    // Belt and braces over the regex, which already excludes whitespace: a
    // newline inside an address is how a header injection starts, and this
    // address is handed to the mailer as a reply-to.
    .refine((v) => !/[\r\n]/.test(v), 'That does not look like an email address.'),
  note: z.string().max(1000).default(''),
});

/**
 * Recent senders, oldest first.
 *
 * In memory rather than in Postgres: the limit exists to stop one person
 * hammering the mailer, it resets on deploy without consequence, and the
 * server is a single long-lived process so a module-level array is a real
 * record. nginx rate-limits the same path in front of this; the two are not
 * redundant, since nginx counts requests and this counts mail sent.
 */
const sent: { ip: string; at: number }[] = [];

const WINDOW_MS = 60 * 60 * 1000;
/** Per address, per hour. Enough to retry a typo, not enough to be a channel. */
const PER_IP = 3;
/** Across everyone, per hour. A backstop against a distributed flood. */
const TOTAL = 40;

function throttled(ip: string, now: number): boolean {
  while (sent.length > 0 && now - sent[0].at > WINDOW_MS) sent.shift();
  if (sent.length >= TOTAL) return true;
  return sent.filter((s) => s.ip === ip).length >= PER_IP;
}

/**
 * The requester's address as far as it can be known.
 *
 * Behind nginx, which sets X-Forwarded-For; the first entry is the client and
 * the rest are proxies. Spoofable by anyone talking to the app directly, which
 * is why the global cap exists alongside the per-address one.
 */
function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || req.headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function POST(req: NextRequest) {
  if (!mailConfigured()) {
    return NextResponse.json(
      { error: 'Account requests are not set up on this server.' },
      { status: 503 },
    );
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' },
      { status: 400 },
    );
  }

  const ip = clientIp(req);
  if (throttled(ip, Date.now())) {
    return NextResponse.json(
      { error: 'Too many requests from here. Try again later.' },
      { status: 429 },
    );
  }

  // Counted before the attempt, not after. A mailer that is down would
  // otherwise leave this endpoint unlimited: every request fails, nothing is
  // recorded, and a stranger can keep the server dialling SMTP for as long as
  // they like. Three a person an hour is enough to retry a genuine failure.
  sent.push({ ip, at: Date.now() });

  try {
    await sendAccessRequest({
      email: parsed.data.email,
      note: parsed.data.note,
      ip: ip === 'unknown' ? null : ip,
      at: new Date(),
    });
  } catch (err) {
    // The reason stays on the server. A stranger learning that the mailbox is
    // full, or what host it is on, helps nobody who is asking in good faith.
    console.error('access request failed to send:', err);
    return NextResponse.json(
      { error: 'Could not send that just now. Try again later.' },
      { status: 502 },
    );
  }

  // Deliberately the same answer whether or not that address already has an
  // account: this page is public, and it is not a way to enumerate users.

  return NextResponse.json({ ok: true });
}
