import Link from 'next/link';
import CommitteeSearch from '@/components/CommitteeSearch';
import HostedBy from '@/components/HostedBy';

/**
 * Chrome for Know Your Mailer.
 *
 * The masthead sits here rather than in each page so that the landing page and
 * a report carry the same heading, which is what makes a shared link arrive
 * somewhere recognizable.
 *
 * The search box sits here for a harder reason. It is the only thing on the
 * site anyone needs twice: read a committee, look up the next one. Anywhere
 * else it ends up below a report, and a report about an operator with 229
 * committees is long enough that "below" means gone.
 *
 * The scroll container is load-bearing. The root layout locks the body to the
 * viewport with overflow-hidden, because the graph explorer owns its own
 * scrolling. These are ordinary documents and have to scroll themselves, or
 * everything below the fold is unreachable.
 *
 * The container is wider than a reading measure because a committee report
 * sets the donors against the payments in two columns, and two lists of names
 * and dollar amounts need the room. Prose inside it is constrained where it
 * appears, so nothing here is set at a line length nobody can read.
 */
export default function KymLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-dvh overflow-y-auto bg-slate-950">
      <div className="mx-auto max-w-5xl px-5 py-8 text-slate-100 sm:py-10">
        {/* Wraps rather than shrinks: below the small breakpoint the box drops
            under the title at full width, where it is still usable, instead of
            squeezing into a gap too narrow to read what you typed. */}
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div>
            <Link href="/kym" className="inline-block">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
                Know Your Mailer
              </h1>
            </Link>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
              Powered by the{' '}
              <a
                href="https://pactrack.sjcrlc.org"
                className="text-slate-400 underline-offset-2 hover:text-indigo-300 hover:underline"
              >
                PAC Tracker
              </a>{' '}
              database
            </p>
            {/* Takes its width from the lines above instead of setting it. At
                its own width the title column would outgrow the room beside
                the search box, and between the small and large breakpoints
                the box would drop under the title. */}
            <HostedBy className="mt-0.5 contain-inline-size" />
          </div>
          <div className="w-full sm:w-72 lg:w-96">
            <CommitteeSearch />
          </div>
        </header>
        {children}

        {/* Every report is built on judgements a reader cannot see from the
            report: which filings were swept, and which filers were decided to
            be one filer. The link sits on every page under this layout rather
            than on the landing page alone, because a shared link arrives at a
            report and never passes the landing page at all. */}
        <footer className="mt-12 border-t border-slate-900 pt-4">
          <p className="text-xs text-slate-600">
            <Link
              href="/methods-and-sources"
              className="text-slate-500 underline-offset-2 hover:text-indigo-300 hover:underline"
            >
              Methods and sources
            </Link>{' '}
            — every feed behind these figures, every filer folded into another, and the nonprofits
            in this data.
          </p>
        </footer>
      </div>
    </div>
  );
}
