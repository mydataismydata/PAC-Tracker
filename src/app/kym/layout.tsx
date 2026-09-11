import Link from 'next/link';

/**
 * Chrome for Know Your Mailer.
 *
 * The masthead sits here rather than in each page so that the landing page and
 * a committee report carry the same heading, which is what makes a shared link
 * arrive somewhere recognizable.
 *
 * The scroll container is load-bearing. The root layout locks the body to the
 * viewport with overflow-hidden, because the graph explorer owns its own
 * scrolling. These are ordinary documents and have to scroll themselves, or
 * everything below the fold is unreachable.
 */
export default function KymLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-dvh overflow-y-auto bg-slate-950">
      <div className="mx-auto max-w-3xl px-5 py-8 text-slate-100 sm:py-10">
        <header>
          <Link href="/kym" className="inline-block">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
              Know Your Mailer
            </h1>
          </Link>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
            Powered by the PAC Tracker database
          </p>
        </header>
        {children}
      </div>
    </div>
  );
}
