/** Sign in, and sign out. */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  GATE_COOKIE,
  clearedCookie,
  issueSession,
  readSession,
  sessionCookie,
  verifyCredentials,
} from '@/lib/gate';

export const dynamic = 'force-dynamic';

/** Who am I? The header needs a name to put on the account button. */
export async function GET(req: NextRequest) {
  const session = await readSession(req.cookies.get(GATE_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  return NextResponse.json({ email: session.email });
}

const schema = z.object({
  email: z.string().min(3).max(200),
  password: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter your email and password.' }, { status: 400 });
  }

  const user = await verifyCredentials(parsed.data.email, parsed.data.password);
  if (!user) {
    // Costs a guessing script far more than it costs a person who mistyped.
    // Deliberately does not say which of the two was wrong.
    await new Promise((r) => setTimeout(r, 500));
    return NextResponse.json({ error: 'Email or password is not right.' }, { status: 401 });
  }

  const { value, maxAge } = await issueSession(user);
  const res = NextResponse.json({
    ok: true,
    email: user.email,
    mustChangePassword: user.mustChangePassword,
  });
  res.cookies.set(sessionCookie(value, maxAge));
  return res;
}

/** Sign out. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(clearedCookie());
  return res;
}
