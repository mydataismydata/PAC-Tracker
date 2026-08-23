/** Sign in with the shared site passphrase. */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { issueSession, passphraseIsValid, sessionCookie } from '@/lib/gate';

export const dynamic = 'force-dynamic';

const schema = z.object({ passphrase: z.string().min(1).max(200) });

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter the password.' }, { status: 400 });
  }

  if (!(await passphraseIsValid(parsed.data.passphrase))) {
    // Costs a guessing script far more than it costs a person who mistyped.
    await new Promise((r) => setTimeout(r, 500));
    return NextResponse.json({ error: 'That password is not right.' }, { status: 401 });
  }

  const { value, maxAge } = await issueSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookie(value, maxAge));
  return res;
}
