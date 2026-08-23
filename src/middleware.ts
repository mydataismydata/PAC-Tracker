/**
 * Passphrase gate for the graph explorer.
 *
 * Two audiences share one host. The sponsor summaries under /person and their
 * JSON under /api/people are public records served in milliseconds, so they
 * stay open. Everything else crawls the whole database and stays closed.
 *
 * Runs on the Node runtime because verifying a session means reading the
 * password hash out of Postgres.
 */

import { NextRequest, NextResponse } from 'next/server';
import { GATE_COOKIE, issueSession, passphraseIsValid, sessionCookie, sessionIsValid } from '@/lib/gate';

export const config = {
  runtime: 'nodejs',
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|person(?:/|$)|api/people(?:/|$)|gate(?:/|$)|api/gate(?:/|$)).*)',
  ],
};

export async function middleware(req: NextRequest) {
  const url = req.nextUrl;

  // Links were handed out as https://host/?p=<passphrase>. Honour them: trade
  // the query parameter for a cookie and drop it from the address bar so the
  // password stops riding along in history and referrers.
  const supplied = url.searchParams.get('p');
  if (supplied && (await passphraseIsValid(supplied))) {
    const clean = new URL(url);
    clean.searchParams.delete('p');
    const res = NextResponse.redirect(clean);
    const { value, maxAge } = await issueSession();
    res.cookies.set(sessionCookie(value, maxAge));
    return res;
  }

  if (await sessionIsValid(req.cookies.get(GATE_COOKIE)?.value)) return NextResponse.next();

  // A fetch() from the canvas cannot follow a redirect into an HTML form and
  // make sense of it. Answer those honestly instead.
  if (url.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const gate = new URL('/gate', url);

  // Whatever ?p= held was wrong or absent; either way it must not be copied
  // into the sign-in URL, where it would sit in history and referrer headers.
  const back = new URL(url);
  back.searchParams.delete('p');
  const target = back.pathname + back.search;
  if (target !== '/') gate.searchParams.set('next', target);

  return NextResponse.redirect(gate);
}
