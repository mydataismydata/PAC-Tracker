/**
 * Change your own password.
 *
 * The session cookie is signed with a key derived from the password hash, so
 * changing it invalidates every session this account has open — which is what
 * you want if the reason for changing it is that someone else saw it. A fresh
 * cookie goes back so the tab that made the change is not signed out of it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  GATE_COOKIE,
  MIN_PASSWORD,
  changePassword,
  issueSession,
  readSession,
  sessionCookie,
  verifyCredentials,
} from '@/lib/gate';

export const dynamic = 'force-dynamic';

const schema = z.object({
  current: z.string().min(1).max(200),
  next: z.string().min(MIN_PASSWORD).max(200),
});

export async function POST(req: NextRequest) {
  // Exempt from the middleware so someone holding a temporary password can
  // reach it, so it checks the session itself.
  const session = await readSession(req.cookies.get(GATE_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `New password must be at least ${MIN_PASSWORD} characters.` },
      { status: 400 },
    );
  }

  const { current, next } = parsed.data;
  const user = await verifyCredentials(session.email, current);
  if (!user) {
    await new Promise((r) => setTimeout(r, 500));
    return NextResponse.json({ error: 'Current password is not right.' }, { status: 401 });
  }
  if (next === current) {
    return NextResponse.json({ error: 'That is your current password.' }, { status: 400 });
  }

  const updated = await changePassword(user.id, next);
  if (!updated) return NextResponse.json({ error: 'Account is gone.' }, { status: 401 });

  const { value, maxAge } = await issueSession(updated);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookie(value, maxAge));
  return res;
}
