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
 *
 * A large network is the subject here, not an obstacle to one. The busiest
 * operator in the data runs 229 committees that paid each other $56M across
 * 1,300 transfers, and every one of those transfers puts another name between
 * a donor and where their money ended up. The page states that figure outright
 * and traces the whole set, because the pooled origins of a network are
 * exactly what the internal shuffle is arranged to obscure.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { db } from '@/db';
import { committeeHref } from '@/lib/graph/committee';
import {
  internalFlow,
  personNetwork,
  roleLabel,
  rolePhrase,
  slugToOfficerName,
  type InternalFlow,
  type PersonNetwork,
} from '@/lib/graph/officers';
import { formatMoney, kindLabel } from '@/lib/graph/types';
import CommitteeSearch from '@/components/CommitteeSearch';
import { Money, MoneyColumns, SectionHeading, Shown, Tile } from '@/components/kym/report';

export const dynamic = 'force-dynamic';

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
 * Last on the page, and full width. It is the evidence behind everything
 * above it — the donors and the payments are the sum of these rows — but an
 * operator with 229 committees makes it 229 rows, and a reader who has to
 * scroll past all of them to reach the findings will not reach the findings.
 * So the answers come first and the working is underneath them.
 */
function Committees({ person }: { person: PersonNetwork }) {
  return (
    <section className="mt-8">
      <SectionHeading>Named on {person.committees.length.toLocaleString()} filings</SectionHeading>
      {/* Every committee, never a slice. The size of the network is the
          finding, and a list that stops at fifty makes the reader take the
          rest on trust. */}
      <Shown
        shown={person.committees.length}
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
        {person.committees.map((c) => {
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

/**
 * What the committees under one person paid each other.
 *
 * Given the same weight as the money in and the money out, because for a
 * network of any size it is the figure that explains the other two. It is
 * shown as a share of what was raised as well as a sum: $56M means little
 * until it is 36% of everything that came in.
 */
function Shuffle({ flow, raised }: { flow: InternalFlow; raised: string }) {
  const share = Number(raised) > 0 ? (Number(flow.amount) / Number(raised)) * 100 : 0;
  return (
    <Tile label="Moved between them" value={flow.amount} tone="self">
      {flow.transfers.toLocaleString()} transfer{flow.transfers === 1 ? '' : 's'} among{' '}
      {flow.payers.toLocaleString()} of these committees
      {share >= 1 && ` · ${share.toFixed(0)}% of what they raised`}
    </Tile>
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
  const inside = await internalFlow(db, person.entityIds);

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

      {/* Three tiles when the group moves money inside itself, two when it
          does not. Stacks below 400px, where two nine-figure sums will not sit
          side by side. */}
      <div
        className={`mt-6 grid grid-cols-2 gap-3 max-[400px]:grid-cols-1 ${
          Number(inside.amount) > 0 ? 'max-w-4xl sm:grid-cols-3' : 'max-w-2xl'
        }`}
      >
        <Tile label="Raised" value={person.totalReceived} tone="in">
          across {person.committees.length.toLocaleString()} filing
          {person.committees.length === 1 ? '' : 's'}
        </Tile>
        <Tile label="Paid out" value={person.totalGiven} tone="out">
          {scope}
        </Tile>
        {Number(inside.amount) > 0 && <Shuffle flow={inside} raised={person.totalReceived} />}
      </div>

      {Number(inside.amount) > 0 && (
        <p className="mt-3 max-w-3xl text-xs leading-relaxed text-slate-500">
          Money moving between committees under the same person is real money, but it neither
          entered nor left the group. Each transfer puts another committee name between a donor and
          whatever the money finally paid for, so the filed contributor list at the far end names a
          committee rather than anybody who gave. The donor column below follows those transfers
          back to whoever paid in from outside.
        </p>
      )}

      <MoneyColumns
        ids={person.entityIds}
        subject={person.name}
        scope={scope}
        cycle={cycle}
        paymentsHint="Everyone these committees paid, pooled and largest first. A vendor paid by several of them is one row."
      />

      <Committees person={person} />

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
