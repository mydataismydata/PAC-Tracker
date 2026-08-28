/**
 * Sign-in, and the forced password change for a new account.
 *
 * Public sponsor summaries live under /person and never reach this; anything
 * that crawls the database does.
 */

import GateForm from '@/components/GateForm';
import RequestAccessForm from '@/components/RequestAccessForm';
import { GATE_COOKIE, countUsers, readSession } from '@/lib/gate';
import { mailConfigured } from '@/lib/mail';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign in — PAC Tracker',
  robots: { index: false, follow: false },
};

export default async function GatePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; change?: string }>;
}) {
  const params = await searchParams;

  // Only ever bounce back into this site. A caller-supplied absolute URL, or a
  // protocol-relative one, would turn the sign-in page into an open redirect.
  const next = params.next && /^\/(?!\/)/.test(params.next) ? params.next : '/';

  const session = await readSession((await cookies()).get(GATE_COOKIE)?.value);
  const mustChange = params.change === '1' && session != null;
  const noAccounts = !session && (await countUsers()) === 0;
  // Offered only where there is somewhere for the request to go. A form that
  // cannot send is worse than no form: it reads as being ignored.
  const canRequest = mailConfigured();

  return (
    <main className="flex h-dvh items-center justify-center overflow-y-auto bg-slate-950 px-4 py-8 text-slate-100">
      <div className="w-full max-w-sm">
        <h1 className="text-lg font-semibold tracking-tight">PAC Tracker</h1>

        {noAccounts ? (
          <>
            <p className="mt-1 text-sm text-slate-400">There are no accounts yet.</p>
            <p className="mt-4 text-xs leading-relaxed text-slate-500">
              Create the first one on the server:
            </p>
            <pre
              className="mt-2 overflow-x-auto rounded border border-slate-800 bg-slate-900
                         px-3 py-2 text-xs text-slate-300"
            >
              docker compose run --rm cli user add you@example.com
            </pre>
          </>
        ) : mustChange ? (
          <>
            <p className="mt-1 text-sm text-slate-400">
              Signed in as {session.email}. Choose your own password before continuing — the
              one you were given is temporary.
            </p>
            <GateForm mode="change" next={next} />
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-slate-400">
              Florida committee and candidate money. Sign in to continue.
            </p>
            <GateForm mode="signin" next={next} />
            <p className="mt-6 text-xs leading-relaxed text-slate-600">
              Forgot your password? Accounts are managed by hand — ask whoever set yours up to
              issue a new one. Individual sponsor summaries are public and need no account.
            </p>
            {canRequest && <RequestAccessForm />}

          </>
        )}
      </div>
    </main>
  );
}
