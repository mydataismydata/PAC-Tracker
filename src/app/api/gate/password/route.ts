/**
 * Rotate the shared site passphrase.
 *
 * Changing it invalidates every outstanding session, including this browser's,
 * because the cookie signing key is derived from the stored hash. A fresh
 * cookie goes back with the response so whoever made the change is not signed
 * out of the tab they made it from.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  GATE_COOKIE,
  MIN_PASSPHRASE,
  issueSession,
  passphraseIsValid,
  sessionCookie,
  sessionIsValid,
  setPassphrase,
} from '@/lib/gate';

export const dynamic = 'force-dynamic';

const schema = z.object({
  current: z.string().min(1).max(200),
  next: z.string().min(MIN_PASSPHRASE).max(200),
});

export async function POST(req: NextRequest) {
  // This route is exempt from the middleware so the sign-in page can reach its
  // sibling, so it checks the session itself.
  if (!(await sessionIsValid(req.cookies.get(GATE_COOKIE)?.value))) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `New password must be at least ${MIN_PASSPHRASE} characters.` },
      { status: 400 },
    );
  }

  const { current, next } = parsed.data;
  if (!(await passphraseIsValid(current))) {
    await new Promise((r) => setTimeout(r, 500));
    return NextResponse.json({ error: 'Current password is not right.' }, { status: 401 });
  }
  if (next === current) {
    return NextResponse.json({ error: 'That is the current password.' }, { status: 400 });
  }

  await setPassphrase(next);

  const { value, maxAge } = await issueSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookie(value, maxAge));
  return res;
}
