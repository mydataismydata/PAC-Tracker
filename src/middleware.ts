/**
 * Sign-in gate for the graph explorer.
 *
 * Two audiences share one host. The sponsor summaries under /person, the
 * committee reports under /kym, /methods-and-sources, and the JSON behind them
 * are public records served in seconds, so they stay open. Everything else
 * crawls the whole database and stays closed.
 *
 * /methods-and-sources is open for a reason beyond speed. It says which filings
 * were swept and which filers were folded into one another, and a figure whose
 * working is behind a sign-in is a figure nobody outside can check.
 *
 * /api/entities/search is deliberately not on that list even though /kym needs
 * a search box. It answers for every entity, private individuals who gave $50
 * and have a home address on file included. /api/kym/search answers the same
 * question for committees only, and is the public one.
 *
 * Runs on the Node runtime because reading a session means looking the account
 * up in Postgres.
 */

import { NextRequest, NextResponse } from 'next/server';
import { GATE_COOKIE, readSession } from '@/lib/gate';

export const config = {
  runtime: 'nodejs',
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|person(?:/|$)|api/people(?:/|$)|kym(?:/|$)|api/kym(?:/|$)|methods-and-sources(?:/|$)|gate(?:/|$)|api/gate(?:/|$)).*)',
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
