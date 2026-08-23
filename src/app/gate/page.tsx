/**
 * Sign-in page for the shared site passphrase.
 *
 * Public sponsor summaries live under /person and never reach this; anything
 * that crawls the database does.
 */

import GateForm from '@/components/GateForm';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'PAC Tracker',
  robots: { index: false, follow: false },
};

export default async function GatePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const requested = (await searchParams).next;

  // Only ever bounce back into this site. A caller-supplied absolute URL, or a
  // protocol-relative one, would turn the sign-in page into an open redirect.
  const next = requested && /^\/(?!\/)/.test(requested) ? requested : '/';

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-950 px-4 text-slate-100">
      <div className="w-full max-w-sm">
        <h1 className="text-lg font-semibold tracking-tight">PAC Tracker</h1>
        <p className="mt-1 text-sm text-slate-400">
          Florida committee and candidate money. Enter the site password to continue.
        </p>
        <GateForm next={next} />
        <p className="mt-6 text-xs leading-relaxed text-slate-600">
          Individual sponsor summaries are public and need no password.
        </p>
      </div>
    </main>
  );
}
