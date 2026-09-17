/**
 * Where every figure on this site comes from, and what has been changed.
 *
 * Public, and linked from both the reports and the graph explorer, because a
 * number nobody can check is a number nobody should act on. Three things are
 * set down here that a report cannot say for itself: which filings were swept
 * and over what years, which filers were decided to be one filer, and which
 * payers were identified as nonprofits and on what evidence.
 *
 * The fold list is the important one. Almost every headline figure on the site
 * is larger than any single filing because several filers were judged to be
 * one operation, and that judgement is ours rather than the state's. It is set
 * out row by row, and it downloads.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { db } from '@/db';
import { methods } from '@/lib/kym/methods';
import { committeeSlug } from '@/lib/graph/committee';
import { formatMoneyFull } from '@/lib/graph/types';
import DataTable, { type Cell } from '@/components/kym/DataTable';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Methods and sources — PAC Tracker',
  description:
    'Every feed behind the PAC Tracker database, the years it covers, the filers it created, every entity folded into another one, and the nonprofits identified in the data.',
};

const KIND_LABELS: Record<string, string> = {
  committee: 'PAC',
  candidate: 'Candidate',
  individual: 'Individual',
  organization: 'Organization',
  party: 'Political party',
  unknown: 'Unclassified',
};

/** A filing date as a year, which is the only part of it this page uses. */
function year(date: string | null): string {
  return date ? date.slice(0, 4) : '—';
}

function span(from: string | null, to: string | null): string {
  if (!from || !to) return '—';
  const a = year(from);
  const b = year(to);
  return a === b ? a : `${a}–${b}`;
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

export default async function MethodsAndSourcesPage() {
  const m = await methods(db);

  const sourceRows: Cell[][] = m.sources.map((s) => [
    s.name,
    span(s.firstFiled, s.lastFiled),
    num(s.records),
    // A feed that moves no money shows a dash rather than $0, which would read
    // as a sweep that found nothing.
    s.carriesMoney ? formatMoneyFull(s.amount) : '—',
  ]);

  const kindRows: Cell[][] = m.kinds.map((k) => {
    const source = m.sources.find((s) => s.key === k.key);
    return [
      source?.name ?? k.key,
      num(k.committee),
      num(k.individual),
      num(k.organization),
      num(k.party),
      num(k.candidate),
    ];
  });

  const foldRows: Cell[][] = m.folds.map((f) => [
    KIND_LABELS[f.targetKind ?? 'unknown'] ?? f.targetKind ?? '—',
    f.name
      ? f.name
      : { text: 'not recorded', muted: true },
    f.sourceKey ?? '—',
    f.targetName && f.targetId
      ? {
          text: f.targetName,
          href:
            f.targetKind === 'committee' || f.targetKind === 'party'
              ? `/kym/${committeeSlug(f.targetName)}?id=${f.targetId}`
              : undefined,
        }
      : { text: 'deleted outright', muted: true },
    f.targetSourceKey ?? '—',
  ]);

  const nonprofitRows: Cell[][] = m.nonprofits.map((n) => [
    n.name,
    n.taxStatus ?? n.corpType ?? '—',
    num(n.officers),
    num(n.transactions),
    formatMoneyFull(n.amount),
  ]);

  return (
    <div className="h-dvh overflow-y-auto bg-slate-950">
      <div className="mx-auto max-w-5xl px-5 py-8 text-slate-100 sm:py-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
            Methods and sources
          </h1>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
            <Link href="/kym" className="text-slate-400 hover:text-indigo-300">
              Know Your Mailer
            </Link>{' '}
            ·{' '}
            <Link href="/" className="text-slate-400 hover:text-indigo-300">
              PAC Tracker
            </Link>
          </p>
        </header>

        <p className="mt-6 max-w-3xl leading-relaxed text-slate-400">
          This database holds {num(m.totals.records)} filings from {m.totals.sources} feeds, covering{' '}
          {span(m.totals.firstFiled, m.totals.lastFiled)} and {formatMoneyFull(m.totals.amount)} in
          contributions and expenditures between {num(m.totals.entities)} filers. Everything on this
          page is derived from those filings. Nothing is estimated.
        </p>

        <DataTable
          heading="Feeds"
          tagline={
            <>
              Figures are as filed. An amended filing replaces the original at the next sweep, so a
              total can move down as well as up. Dates are the first and last filing in each feed,
              which is not the same as the period the feed covers: the state publishes expenditures
              only from November 2022, and 2018 contributions were never swept.
            </>
          }
          columns={[
            { label: 'Source' },
            { label: 'Ingested dates' },
            { label: 'Records', numeric: true },
            { label: '$', numeric: true },
          ]}
          rows={sourceRows}
          filename="pactracker-sources"
        />

        <DataTable
          heading="Filers by feed"
          tagline={
            <>
              Each filer is counted once, against the feed that first created it. A committee that
              files with both the state and a county is one filer here, under whichever sweep
              reached it first, so these columns add up to the number of filers in the database
              rather than to the number of appearances.
            </>
          }
          columns={[
            { label: 'Source' },
            { label: 'PACs', numeric: true },
            { label: 'Individuals', numeric: true },
            { label: 'Organizations', numeric: true },
            { label: 'Political parties', numeric: true },
            { label: 'Candidates', numeric: true },
          ]}
          rows={kindRows}
          filename="pactracker-filers-by-feed"
        />

        <DataTable
          heading="Entities folded into another"
          collapsible
          tagline={
            <>
              One operation files under several spellings, and sometimes under several accounts.
              Where two filers were judged to be one, the rows moved to the survivor and the other
              was deleted. Every one of those judgements is listed here. The type is the type of the
              filer that now holds the money.
            </>
          }
          columns={[
            { label: 'Type' },
            { label: 'Folded entity' },
            { label: 'Source' },
            { label: 'Target entity' },
            { label: 'Source' },
          ]}
          rows={foldRows}
          filename="pactracker-folded-entities"
          footnote={
            m.unnamedFolds > 0 ? (
              <>
                {num(m.unnamedFolds)} {m.unnamedFolds === 1 ? 'fold' : 'folds'} here{' '}
                {m.unnamedFolds === 1 ? 'predates' : 'predate'} this record and{' '}
                {m.unnamedFolds === 1 ? 'names' : 'name'} only the filer that received the money.
                The feed a folded filer came from is blank for the same reason on everything folded
                before the record began: a deleted row cannot be asked which sweep created it.
              </>
            ) : undefined
          }
        />

        <DataTable
          heading="Nonprofits in this data"
          collapsible
          tagline={
            <>
              Some of the largest payers into Florida politics are not committees at all. They are
              nonprofit corporations, which file with the IRS rather than with the Division of
              Elections and do not disclose their donors. Each one here was matched by name and
              address to a Florida Not-For-Profit Corporation record in the Sunbiz quarterly feed,
              and to an IRS Form 990 through ProPublica&rsquo;s Nonprofit Explorer, which is where
              the tax status and the officers come from. The amount is what the nonprofit paid out,
              as reported by whoever received it.
            </>
          }
          columns={[
            { label: 'Nonprofit' },
            { label: 'Type' },
            { label: 'Officers', numeric: true },
            { label: 'Transactions', numeric: true },
            { label: 'Amount', numeric: true },
          ]}
          rows={nonprofitRows}
          filename="pactracker-nonprofits"
          footnote={
            <>
              An officer count of zero means the corporation is not registered in Florida. The
              directors and the registered agent come from the Sunbiz feed, which covers Florida
              corporations only, so a nonprofit incorporated in Virginia or Delaware appears here
              with its tax status and its money but with nobody named against it.
            </>
          }
        />

        <p className="mt-10 max-w-3xl text-xs leading-relaxed text-slate-600">
          Figures are as filed with the Florida Division of Elections, the county supervisors of
          elections, the Federal Election Commission and the Internal Revenue Service, and may be
          amended.
        </p>
      </div>
    </div>
  );
}
