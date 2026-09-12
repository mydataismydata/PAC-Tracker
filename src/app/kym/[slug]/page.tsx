/**
 * One committee's report, reachable by the name printed on its mail.
 *
 * Three questions, in the order a mailer's recipient asks them. Who runs this,
 * who paid for it, and what did they spend it on.
 *
 * The money half lives in `src/components/kym/report.tsx`, which a person's
 * page shares, so the two cannot drift apart.
 */

import Image from 'next/image';
import Link from 'next/link';
import type { Metadata } from 'next';
import { db } from '@/db';
import {
  committeeById,
  committeeHref,
  committeesBySlug,
  searchCommittees,
  type CommitteeSubject,
} from '@/lib/graph/committee';
import { officersForEntity, rolePhrase, type EntityOfficer } from '@/lib/graph/officers';
import { OFFICE_LABELS } from '@/lib/graph/person';
import { formatMoney, kindLabel } from '@/lib/graph/types';
import { RING_ONE, RING_TWO_EACH } from '@/lib/kym/snapshot';
import { Money, MoneyColumns, SectionHeading, Tile } from '@/components/kym/report';

export const dynamic = 'force-dynamic';

type Params = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ id?: string; cycle?: string }>;
};

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Which committee this URL means.
 *
 * `?id=` pins one, and is what the search box and every internal link carry. A
 * bare slug is what a shared or hand-typed link carries, and it can be
 * ambiguous: three separate committees file as "Florida Forward". The page
 * asks rather than guessing, so `matches` comes back whole.
 */
async function resolve(p: Params): Promise<{
  slug: string;
  cycle?: string;
  subject: CommitteeSubject | null;
  matches: CommitteeSubject[];
}> {
  const { slug } = await p.params;
  const { id, cycle } = await p.searchParams;

  if (id && UUID.test(id)) {
    const subject = await committeeById(db, id);
    if (subject) return { slug, cycle, subject, matches: [subject] };
  }

  const matches = await committeesBySlug(db, slug);
  return { slug, cycle, subject: matches.length === 1 ? matches[0] : null, matches };
}

/**
 * A candidate account, read off its filed name.
 *
 * The state files a campaign account as `Donalds, Byron (REP)(GOV)`: surname,
 * given name, party, office. That is enough to say what the account is for
 * and to link back to the person, whose page holds every account they have.
 */
function candidacy(subject: CommitteeSubject): {
  line: string;
  person: { last: string; first: string } | null;
} | null {
  if (subject.kind !== 'candidate') return null;
  const codes = subject.name.match(/\(([A-Z]{2,4})\)\s*\(([A-Z]{2,4})\)\s*$/);
  const office = codes ? (OFFICE_LABELS[codes[2]] ?? codes[2]) : null;
  const line = office ? `Campaign account for ${office}${codes ? ` (${codes[1]})` : ''}` : 'Campaign account';
  const name = subject.name.match(/^([^,(]+),\s*([A-Za-z'-]+)/);
  const person = name ? { last: name[1].trim(), first: name[2] } : null;
  return { line, person };
}

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { subject } = await resolve({ params, searchParams });
  if (!subject) return { title: 'Know Your Mailer — PAC Tracker' };
  return {
    title: `${subject.name} — Know Your Mailer`,
    description: `${subject.name} has raised ${formatMoney(subject.totalReceived)} and paid out ${formatMoney(subject.totalGiven)}.`,
  };
}

/**
 * Who the committee tells the state is running it.
 *
 * One row per person, not per role. The chair of a committee is very often
 * also its treasurer, and listing the same name twice reads as two people.
 *
 * The committee count beside each name is not decoration. It is what decides
 * whether a shared name means anything: named on three committees is a
 * finding, named on 229 is a filing practice, and the number is the only thing
 * on the row that tells the reader which they are looking at. It counts every
 * role, because that is what the page behind the link shows.
 */
function Registration({
  officers,
  spansRegistrations,
}: {
  officers: EntityOfficer[];
  spansRegistrations: boolean;
}) {
  const people = new Map<string, { officer: EntityOfficer; roles: string[] }>();
  for (const o of officers) {
    const held = people.get(o.normalizedName);
    if (held) held.roles.push(o.role);
    else people.set(o.normalizedName, { officer: o, roles: [o.role] });
  }

  return (
    <section className="mt-8">
      <SectionHeading>On the registration</SectionHeading>
      {/* Two people in one role is not a contradiction here: a committee that
          re-registered keeps the officers of the registration it closed. */}
      {spansRegistrations && (
        <p className="mt-1 text-xs text-slate-600">
          Covers every registration this committee has held, so a role can name more than one
          person.
        </p>
      )}
      <ul className="mt-2 divide-y divide-slate-900 rounded border border-slate-800">
        {[...people.values()].map(({ officer, roles }) => (
          <li
            key={officer.normalizedName}
            className="px-4 py-2.5 sm:flex sm:items-baseline sm:gap-4"
          >
            <span className="block text-[11px] uppercase tracking-wide text-slate-500 sm:w-40 sm:shrink-0">
              {rolePhrase(roles)}
            </span>
            <Link
              href={`/kym/person/${officer.slug}`}
              className="mt-0.5 block truncate text-sm text-slate-200 underline-offset-2 hover:text-indigo-300 hover:underline sm:mt-0 sm:min-w-0 sm:flex-1"
            >
              {officer.fullName}
            </Link>
            <span className="mt-0.5 block text-xs text-slate-600 sm:mt-0 sm:shrink-0">
              {officer.network === 1
                ? 'this committee only'
                : `named on ${officer.network.toLocaleString()} committees`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Nobody files under this name. Offer the near misses instead of a bare 404. */
async function NotFound({ slug }: { slug: string }) {
  const near = await searchCommittees(db, slug.replace(/[-_]+/g, ' '), 8);
  return (
    <main className="mt-8 max-w-3xl">
      <h2 className="text-xl font-semibold text-slate-100">No committee files under that name</h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-400">
        Nothing in the database is registered as{' '}
        <span className="text-slate-200">{slug.replace(/[-_]+/g, ' ')}</span>. Committee names on
        mail are often shortened, so search for part of it above.
      </p>
      {near.length > 0 && (
        <section className="mt-8">
          <SectionHeading>Closest names on file</SectionHeading>
          <ul className="mt-2 divide-y divide-slate-900 rounded border border-slate-800">
            {near.map((c) => (
              <li key={c.id}>
                <Link
                  href={committeeHref(c)}
                  className="flex items-baseline gap-3 px-4 py-2.5 hover:bg-slate-900/60"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{c.name}</span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-emerald-400">
                    {formatMoney(c.totalReceived)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/**
 * Several committees file under this one name.
 *
 * Folding them together would invent a committee that does not exist and hand
 * the reader a total nobody ever raised, so the choice goes back to them. The
 * account number is what actually separates these: it is the filing office's
 * own identifier, and it is the only field guaranteed to differ.
 */
function Chooser({ slug, matches }: { slug: string; matches: CommitteeSubject[] }) {
  return (
    <main className="mt-8 max-w-3xl">
      <h2 className="text-xl font-semibold text-slate-100">
        {matches.length} filings under this name
      </h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-400">
        They are separate accounts with separate money. A committee can share its name with
        another, and a candidate opens one account per office sought. Pick the one you mean.
      </p>
      <ul className="mt-5 divide-y divide-slate-900 rounded border border-slate-800">
        {matches.map((c) => (
          <li key={c.id}>
            <Link
              href={`/kym/${slug}?id=${c.id}`}
              className="block px-4 py-3 hover:bg-slate-900/60 sm:flex sm:items-baseline sm:gap-3"
            >
              <span className="sm:min-w-0 sm:flex-1">
                <span className="block truncate text-sm text-slate-200">{c.name}</span>
                <span className="block truncate text-xs text-slate-500">
                  {c.accountNumber ? `account ${c.accountNumber}` : 'no account number on file'}
                  {c.city ? ` · ${c.city}, ${c.stateCode ?? ''}` : ''}
                  {c.firstDate ? ` · active from ${c.firstDate}` : ''}
                </span>
              </span>
              <span className="mt-1 block shrink-0 text-sm sm:mt-0">
                <Money value={c.totalReceived} tone="in" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

/**
 * The neighborhood as a picture, for taking away.
 *
 * Drawn by `/api/kym/snapshot`, which caches the file, so the page emits the
 * tag and nothing more; a first draw takes a few seconds and the page must
 * not wait on it. Sized as a square here because the drawn picture nearly is
 * one, and the browser corrects the height once it has the file.
 */
function Snapshot({
  subject,
  cycle,
  scope,
}: {
  subject: CommitteeSubject;
  cycle?: string;
  scope: string;
}) {
  const src = `/api/kym/snapshot/${subject.id}${cycle ? `?cycle=${encodeURIComponent(cycle)}` : ''}`;
  const what = subject.kind === 'candidate' ? 'campaign' : 'committee';
  return (
    <section className="mt-10">
      <SectionHeading>Two hops out · {scope}</SectionHeading>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-600">
        Who this {what} paid or was paid by, and who they paid or were paid by: the {RING_ONE}{' '}
        that moved the most money with it, and the {RING_TWO_EACH} that moved the most with each
        of those. Only direct links are drawn, which means both ends went on to move money
        themselves. Donors who only give are left out, so the chain stays readable. Open the
        picture to save it.
      </p>
      <a
        href={src}
        target="_blank"
        rel="noopener"
        className="mt-3 block max-w-3xl overflow-hidden rounded border border-slate-800 bg-slate-950 hover:border-slate-700"
      >
        <Image
          src={src}
          alt={`${subject.name}: money to and from other committees, two hops out`}
          width={1600}
          height={1600}
          unoptimized
          className="h-auto w-full"
        />
      </a>
    </section>
  );
}

export default async function KymCommitteePage({ params, searchParams }: Params) {
  const { slug, cycle, subject, matches } = await resolve({ params, searchParams });

  if (!subject) {
    return matches.length === 0 ? (
      <NotFound slug={slug} />
    ) : (
      <Chooser slug={slug} matches={matches} />
    );
  }

  const officers = await officersForEntity(db, subject.id);
  const scope = cycle ? `${cycle.slice(0, 4)} cycle` : 'all cycles on file';
  const campaign = candidacy(subject);
  const identity = [
    campaign?.line ?? kindLabel({ kind: subject.kind, committeeType: subject.committeeType }),
    subject.city ? `${subject.city}, ${subject.stateCode ?? ''}`.trim() : null,
    subject.accountNumber ? `account ${subject.accountNumber}` : null,
    subject.status === 'closed' ? 'closed' : null,
    subject.priorRegistrations > 0
      ? `${subject.priorRegistrations} earlier registration${subject.priorRegistrations === 1 ? '' : 's'} on file`
      : null,
  ].filter(Boolean);

  return (
    <main className="mt-8">
      <h2 className="text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
        {subject.name}
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-slate-400">{identity.join(' · ')}</p>
      {subject.firstDate && subject.lastDate && (
        <p className="mt-0.5 text-xs text-slate-600">
          Filings on file from {subject.firstDate} to {subject.lastDate}.
        </p>
      )}
      {/* One account is a fraction of a politician's money. Say so, and point
          at the whole. */}
      {campaign?.person && (
        <p className="mt-2 text-sm text-slate-400">
          One of this candidate&rsquo;s accounts.{' '}
          <Link
            href={`/person/${encodeURIComponent(campaign.person.last)}/${encodeURIComponent(campaign.person.first)}`}
            className="text-indigo-300 underline-offset-2 hover:underline"
          >
            See every filing in their name
          </Link>
          .
        </p>
      )}

      {/* Stacks on a narrow phone. Two columns cannot hold a nine-figure sum
          beside another one, and a statewide committee produces those. */}
      <div className="mt-6 grid max-w-2xl grid-cols-2 gap-3 max-[400px]:grid-cols-1">
        <Tile label="Raised" value={subject.totalReceived} tone="in">
          from {subject.inDegree.toLocaleString()} contributor
          {subject.inDegree === 1 ? '' : 's'}
        </Tile>
        <Tile label="Paid out" value={subject.totalGiven} tone="out">
          to {subject.outDegree.toLocaleString()} recipient{subject.outDegree === 1 ? '' : 's'}
        </Tile>
      </div>

      {officers.length > 0 && (
        <Registration officers={officers} spansRegistrations={subject.priorRegistrations > 0} />
      )}

      <MoneyColumns
        ids={[subject.id]}
        subject={subject.name}
        scope={scope}
        cycle={cycle}
        paymentsHint={
          campaign
            ? 'Everyone this campaign paid, largest first. Mail vendors, consultants and refunds all appear here.'
            : 'Everyone this committee paid, largest first. Mail vendors, consultants and transfers to other committees all appear here.'
        }
      />

      <Snapshot subject={subject} cycle={cycle} scope={scope} />

      <p className="mt-8 text-xs leading-relaxed text-slate-600">
        Figures are as filed with the Florida Division of Elections and the county supervisors of
        elections, and may be amended.
      </p>
    </main>
  );
}
