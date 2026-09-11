/**
 * One person named on committee filings, and everything they are named on.
 *
 * A mailer's disclaimer gives a committee; the committee's registration gives
 * a chair, a treasurer and a registered agent. This is where those names lead.
 * The same person very often runs several committees, and that is the thing
 * the individual committee pages cannot show.
 *
 * Keyed on the name rather than on one role. A quarter of the people in the
 * filings hold more than one — the chair of a committee is very often also its
 * treasurer — and a page per role would hand a reader two pages for one person
 * with the same committees listed on both.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { db } from '@/db';
import { committeeHref } from '@/lib/graph/committee';
import {
  personNetwork,
  roleLabel,
  rolePhrase,
  slugToOfficerName,
  type PersonNetwork,
} from '@/lib/graph/officers';
import { formatMoney, kindLabel } from '@/lib/graph/types';
import CommitteeSearch from '@/components/CommitteeSearch';
import { Money, MoneyColumns, Note, SectionHeading, Shown, Tile } from '@/components/kym/report';

export const dynamic = 'force-dynamic';

/**
 * How many committees a person can hold before the pooled trace stops meaning
 * anything.
 *
 * Tracing the origins of one network answers a question. Tracing the origins
 * of every committee that happens to share a filing agent answers none: the
 * busiest name in the data is on 229 of them, spanning $155M raised by people
 * who have nothing to do with each other. The committee list stays, so a
 * reader can open any single one of them and get a real answer there.
 */
const TRACEABLE = 25;

/**
 * Rows in the committee list.
 *
 * Everyone with a handful of committees sees all of them; only the filing
 * agents hit this, and two hundred rows of theirs is a wall rather than a
 * list. The caption carries the full count and the full total either way.
 */
const LIST_ROWS = 50;

/** Filed spellings named outright before the rest are counted instead. */
const SPELLINGS = 4;

type Params = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ cycle?: string }>;
};

async function load(p: Params['params']): Promise<PersonNetwork | null> {
  const { slug } = await p;
  return personNetwork(db, slugToOfficerName(decodeURIComponent(slug)));
}

export async function generateMetadata({ params }: Pick<Params, 'params'>): Promise<Metadata> {
  const person = await load(params);
  if (!person) return { title: 'Know Your Mailer — PAC Tracker' };
  return {
    title: `${person.name} — Know Your Mailer`,
    description: `${person.name} is named on ${person.committees.length} Florida committee filings, which have raised ${formatMoney(person.totalReceived)} between them.`,
  };
}

/**
 * Every committee this person is named on, with what it raised and what it
 * paid out.
 *
 * A single column above the donor and payment lists, because it is the thing
 * that makes the two columns below it mean something: they are the sum of
 * these rows, and a reader who cannot see what went into the sum cannot judge
 * it.
 */
function Committees({ person }: { person: PersonNetwork }) {
  return (
    <section className="mt-8">
      <SectionHeading>Named on {person.committees.length.toLocaleString()} filings</SectionHeading>
      <Shown
        shown={Math.min(person.committees.length, LIST_ROWS)}
        total={person.committees.length}
        amount={Number(person.totalReceived)}
      />
      {/* Column headers, so the two figures on every row are named once
          rather than guessed at or explained underneath. */}
      <div className="mt-2 hidden items-baseline gap-4 px-4 pb-1 text-[11px] uppercase tracking-wide text-slate-500 sm:flex">
        <span className="min-w-0 flex-1">Committee</span>
        <span className="w-32 shrink-0 text-right">Raised</span>
        <span className="w-32 shrink-0 text-right">Paid out</span>
      </div>
      <ul className="divide-y divide-slate-900 rounded border border-slate-800 sm:mt-0">
        {person.committees.slice(0, LIST_ROWS).map((c) => {
          const label = (
            <>
              <span className="block truncate text-sm text-slate-200">{c.name}</span>
              <span className="block truncate text-xs text-slate-500">
                {rolePhrase(c.roles)} ·{' '}
                {kindLabel({ kind: c.kind, committeeType: c.committeeType })}
                {c.city ? ` · ${c.city}, ${c.stateCode ?? ''}` : ''}
                {c.status === 'closed' ? ' · closed' : ''}
              </span>
            </>
          );
          return (
            <li key={c.id} className="px-4 py-2.5 sm:flex sm:items-baseline sm:gap-4">
              <span className="sm:min-w-0 sm:flex-1">
                {/* A report page exists for committees and parties. A
                    corporation reached through a directorship has none, so its
                    name is text rather than a link into a 404. */}
                {c.kind === 'committee' || c.kind === 'party' ? (
                  <Link
                    href={committeeHref(c)}
                    className="block underline-offset-2 hover:text-indigo-300 hover:underline"
                  >
                    {label}
                  </Link>
                ) : (
                  label
                )}
              </span>
              {/* The column headers above are hidden on a phone, where there
                  is no room for them, so each figure names itself instead. */}
              <span className="mt-1 flex shrink-0 items-baseline gap-4 text-sm sm:mt-0">
                <span className="flex items-baseline gap-1.5 sm:w-32 sm:justify-end">
                  <span className="text-[10px] uppercase tracking-wide text-slate-600 sm:hidden">
                    in
                  </span>
                  <Money value={c.totalReceived} tone="in" />
                </span>
                <span className="flex items-baseline gap-1.5 sm:w-32 sm:justify-end">
                  <span className="text-[10px] uppercase tracking-wide text-slate-600 sm:hidden">
                    out
                  </span>
                  <Money value={c.totalGiven} tone="out" />
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default async function KymPersonPage({ params, searchParams }: Params) {
  const person = await load(params);
  const { cycle } = await searchParams;

  if (!person) {
    return (
      <main className="mt-8 max-w-3xl">
        <h2 className="text-xl font-semibold text-slate-100">Nobody on file under that name</h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-400">
          Only the people a committee currently reports to its filing office have a page here.
          Start from a committee instead.
        </p>
        <div className="mt-5">
          <CommitteeSearch autoFocus />
        </div>
      </main>
    );
  }

  const scope = cycle ? `${cycle.slice(0, 4)} cycle` : 'all cycles on file';
  const roles = person.roles
    .map((r) => `${roleLabel(r.role)} of ${r.committees.toLocaleString()}`)
    .join(' · ');
  const tooBroad = person.committees.length > TRACEABLE;

  return (
    <main className="mt-8">
      <h2 className="text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
        {person.name}
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-slate-400">{roles}</p>
      {/* Never folded silently. Two spellings on file may be one person with a
          typo, or two people the normalized key could not tell apart. */}
      {person.spellings.length > 1 && (
        <p className="mt-0.5 text-xs text-slate-600">
          Also filed as {person.spellings.slice(1, 1 + SPELLINGS).join(', ')}
          {person.spellings.length > 1 + SPELLINGS &&
            `, and ${(person.spellings.length - 1 - SPELLINGS).toLocaleString()} more spellings`}
          .
        </p>
      )}

      <div className="mt-6 grid max-w-2xl grid-cols-2 gap-3 max-[400px]:grid-cols-1">
        <Tile label="Raised" value={person.totalReceived} tone="in">
          across {person.committees.length.toLocaleString()} filing
          {person.committees.length === 1 ? '' : 's'}
        </Tile>
        <Tile label="Paid out" value={person.totalGiven} tone="out">
          {scope}
        </Tile>
      </div>

      <Committees person={person} />

      <MoneyColumns
        ids={person.entityIds}
        subject={person.name}
        scope={scope}
        cycle={cycle}
        paymentsHint="Everyone these committees paid, pooled and largest first. A vendor paid by several of them is one row."
        originsInstead={
          tooBroad ? (
            <Note>
              {person.name} is named on {person.committees.length.toLocaleString()} committees. That
              many is a filing practice rather than a network, and the pooled origins of all of them
              would describe nobody. Open a single committee above to trace its money.
            </Note>
          ) : undefined
        }
      />

      <div className="mt-10 max-w-2xl">
        <SectionHeading>Look up a committee</SectionHeading>
        <div className="mt-2">
          <CommitteeSearch />
        </div>
      </div>

      <p className="mt-8 text-xs leading-relaxed text-slate-600">
        Officers are as currently reported to the Florida Division of Elections and the county
        supervisors of elections. People are matched on surname and given name, so two people
        sharing both would appear here as one.
      </p>
    </main>
  );
}
