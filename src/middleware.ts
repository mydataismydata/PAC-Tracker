/**
 * Sign-in gate for the graph explorer.
 *
 * Two audiences share one host. The sponsor summaries under /person and their
 * JSON under /api/people are public records served in milliseconds, so they
 * stay open. Everything else crawls the whole database and stays closed.
 *
 * Runs on the Node runtime because reading a session means looking the account
 * up in Postgres.
 */

import { NextRequest, NextResponse } from 'next/server';
import { GATE_COOKIE, readSession } from '@/lib/gate';

export const config = {
  runtime: 'nodejs',
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|person(?:/|$)|api/people(?:/|$)|gate(?:/|$)|api/gate(?:/|$)).*)',
  ],
};

export async function middleware(req: NextRequest) {
  const url = req.nextUrl;
  const session = await readSession(req.cookies.get(GATE_COOKIE)?.value);

  if (session && !session.mustChangePassword) return NextResponse.next();

  // A fetch() from the canvas cannot follow a redirect into an HTML form and
  // make sense of it. Answer those honestly instead.
  if (url.pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: session ? 'Password change required' : 'Not signed in' },
      { status: 401 },
    );
  }

  const gate = new URL('/gate', url);

  if (session) {
    // Signed in on a temporary password. Nothing else loads until it is
    // replaced, or the operator-issued password stays live indefinitely.
    gate.searchParams.set('change', '1');
    return NextResponse.redirect(gate);
  }

  const target = url.pathname + url.search;
  if (target !== '/') gate.searchParams.set('next', target);
  return NextResponse.redirect(gate);
}
