/**
 * The PAC namer.
 *
 * An operator who files 229 committees needs 229 names for them, and Florida
 * asks nothing of a name except that somebody typed it. What comes out is a
 * vocabulary of about forty interchangeable civic abstractions recombined:
 * 55 of his committees contain "Florida", 22 are "Friends of" somebody, 20 are
 * a permutation of "Sunshine State" and "Leadership Fund", and 31 of the 229
 * are a second registration of a name already in the set.
 *
 * That is the joke and it is also the point. A mailer has to name whoever paid
 * for it, and a name drawn from this pot identifies nobody — which is what the
 * rest of Know Your Mailer exists to get past. Every word below is his.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { db } from '@/db';
import { nameVocabulary, personNetwork, slugToOfficerName } from '@/lib/graph/officers';
import Namer from '@/components/kym/Namer';
import { invent } from '@/lib/kym/namer';

export const dynamic = 'force-dynamic';

/** Whose committees the words come from, unless the URL names somebody else. */
const DEFAULT_WHO = 'jones-william';

/**
 * Locally he is Stafford Jones. The state filings spell him "William S.
 * Jones", which is the name stored and the name every other page shows, but a
 * title is prose and prose should use the name a reader recognizes.
 */
const KNOWN_AS: Record<string, string> = { 'jones-william': 'Stafford Jones' };

type Params = { searchParams: Promise<{ who?: string }> };

async function load(searchParams: Params['searchParams']) {
  const slug = (await searchParams).who || DEFAULT_WHO;
  const person = await personNetwork(db, slugToOfficerName(slug));
  if (!person) return null;
  return {
    person,
    called: KNOWN_AS[slug] ?? person.name,
    pool: await nameVocabulary(db, person.entityIds),
  };
}

export async function generateMetadata({ searchParams }: Params): Promise<Metadata> {
  const loaded = await load(searchParams);
  return {
    title: loaded ? `The ${loaded.called} PAC Namer` : 'PAC Namer — Know Your Mailer',
    description:
      'Assemble a Florida political committee name from the words one operator actually uses.',
    // Not meant to be found from a search engine. It is meant to be found.
    robots: { index: false, follow: false },
  };
}

export default async function NamerPage({ searchParams }: Params) {
  const loaded = await load(searchParams);

  if (!loaded || loaded.pool.length < 4) {
    return (
      <main className="mt-8 max-w-3xl">
        <h2 className="text-xl font-semibold text-slate-100">Not enough names to work from</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          This needs somebody who has filed a good many committees. Try{' '}
          <Link href="/kym/namer" className="text-indigo-300 underline underline-offset-2">
            the default
          </Link>
          .
        </p>
      </main>
    );
  }

  const { person, called, pool } = loaded;
  const top = pool.slice(0, 12);

  return (
    <main className="mt-8 max-w-3xl">
      <h2 className="text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
        The {called} PAC Namer
      </h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-400">
        Florida asks nothing of a committee name except that somebody typed it.{' '}
        <Link
          href={`/kym/person/${person.slug}`}
          className="text-slate-200 underline underline-offset-2 hover:text-indigo-300"
        >
          {person.name}
        </Link>{' '}
        has needed {person.committees.length.toLocaleString()} of them, and every word below is one
        he used.
      </p>

      <div className="mt-6">
        {/* The first name is made here so the server and the client agree on
            what to render; the button takes over from there. */}
        <Namer pool={pool} first={invent(pool)} />
      </div>

      <section className="mt-10">
        <h3 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
          The vocabulary
        </h3>
        <p className="mt-1 text-xs text-slate-600">
          {pool.length.toLocaleString()} words appear on more than one of his committees. A common
          one comes up here as often as it does there.
        </p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {top.map((w) => (
            <li
              key={w.word}
              className="rounded border border-slate-800 bg-slate-900/40 px-2.5 py-1 text-sm text-slate-300"
            >
              {w.word}{' '}
              <span className="font-mono text-xs tabular-nums text-slate-600">
                ×{w.committees}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-10 max-w-prose text-xs leading-relaxed text-slate-600">
        A mailer has to name whoever paid for it, and a name assembled out of this pot names
        nobody. That is what the rest of this site is for:{' '}
        <Link href="/kym" className="text-slate-400 underline underline-offset-2">
          look up a real one
        </Link>
        .
      </p>
    </main>
  );
}
