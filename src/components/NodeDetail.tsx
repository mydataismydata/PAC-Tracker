'use client';

/**
 * Inspector for the selected tile.
 *
 * The ledger below the stats reads from the database, not from the crawl. The
 * graph is always a capped, filtered slice — a candidate with 297 contributors
 * may show one edge in `direct` mode — so the panel has to be able to account
 * for every dollar in the headline totals rather than the handful of edges that
 * happen to be drawn.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  committeeCount,
  formatMoney,
  formatMoneyFull,
  kindLabel,
  isOfficerNode,
  kindColor,
  type FocusLink,
  type GraphNode,
} from '@/lib/graph/types';
import { useTrace, type TraceResult } from '@/lib/graph/useTrace';
import type { EntityOfficer, OfficerSubject } from '@/lib/graph/useOfficers';
import {
  isSourceRow,
  useLedger,
  type LedgerDirection,
  type LedgerRow,
  type LedgerSort,
  type LedgerView,
} from '@/lib/graph/useLedger';

interface Props {
  node: GraphNode | null;
  /** Nodes currently drawn, so the panel can mark which rows are on the canvas. */
  nodes: Map<string, GraphNode>;
  onFocus: (nodeId: string, link?: FocusLink) => void;
  onRecenter: (nodeId: string) => void;
  /**
   * The person behind an officer hub, resolved by the parent.
   *
   * Fetched above rather than here because the bar over the canvas shows the
   * same totals, and two copies of this hook would mean two requests for one
   * answer.
   */
  subject: OfficerSubject | null;
  /** Chair and treasurer, fetched by the parent for the bar over the canvas. */
  officers: EntityOfficer[];
  /**
   * Which side of the ledger to show. Owned by the parent, because the tiles
   * that set it now sit over the canvas rather than in this panel.
   */
  direction: LedgerDirection;
  onDirectionChange: (d: LedgerDirection) => void;
  /** Looking at something other than the entity searched. Accents the header. */
  exploring: boolean;
  /**
   * The graph's date range.
   *
   * A crawl setting rather than a ledger one, shown here because it is read
   * against these rows — but note that it narrows the map, not the list.
   */
  dateFrom?: string;
  dateTo?: string;
  onDatesChange: (from: string | undefined, to: string | undefined) => void;
  /** Election cycle the graph is filtered to, or undefined for all. */
  cycle?: string;
}

const DIRECTIONS: { value: LedgerDirection; label: string }[] = [
  { value: 'in', label: 'Money in' },
  { value: 'out', label: 'Money out' },
  { value: 'all', label: 'Both' },
];

type PanelMode = 'sources' | 'transactions' | 'origins';

const PANEL_MODES: { value: PanelMode; label: string; hint: string }[] = [
  { value: 'sources', label: 'By party', hint: 'One row per counterparty, aggregated.' },
  { value: 'transactions', label: 'Every transaction', hint: 'One row per reported line item.' },
  {
    value: 'origins',
    label: 'Funding origins',
    hint: 'Follow the money past committee-to-committee transfers to whoever originated it.',
  },
];

/**
 * A tab's natural default: the transaction list is a chronology, so it opens
 * newest-first; the aggregated views are about size, so they open largest-first.
 * Applied on tab switch rather than derived, so a sort the reader picks by hand
 * survives until they move tabs again.
 */
function defaultSortFor(mode: PanelMode): LedgerSort {
  return mode === 'transactions' ? 'date' : 'amount';
}

export default function NodeDetail({
  node,
  nodes,
  onFocus,
  onRecenter,
  subject,
  officers,
  direction,
  onDirectionChange,
  exploring,
  dateFrom,

  dateTo,
  onDatesChange,
  cycle,
}: Props) {
  const [mode, setMode] = useState<PanelMode>('sources');
  const [sort, setSort] = useState<LedgerSort>('amount');
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);
  const [dateOrdered, setDateOrdered] = useState(true);

  // The origins tab asks a different question of the same subject, so the
  // ledger keeps its last view rather than being torn down and refetched.
  const view: LedgerView = mode === 'origins' ? 'sources' : mode;
  const showLedger = mode !== 'origins';

  // An officer hub is a person rather than an entity, and answers the same
  // questions over the union of the committees naming them. `subjectApiBase`
  // routes the hooks; everything below is identical either way.
  const officerHub = node !== null && isOfficerNode(node.id);
  const subjectId = node?.id ?? null;

  const query = useMemo(
    () => ({ view, direction, q, sort, cycle, dateFrom, dateTo }),
    [view, direction, q, sort, cycle, dateFrom, dateTo],
  );

  const ledger = useLedger(subjectId, query);
  const traceQuery = useMemo(
    () => ({ depth: 12, min: 100, dateOrdered, cycle, dateFrom, dateTo }),
    [dateOrdered, cycle, dateFrom, dateTo],
  );
  const traced = useTrace(subjectId, traceQuery, mode === 'origins');



  // A hub holds nothing itself; its headline is the union of its committees.
  const received = subject?.totalReceived ?? node?.totalReceived ?? '0';
  const given = subject?.totalGiven ?? node?.totalGiven ?? '0';

  // Phones scroll the whole panel, so the identity line has to follow and the
  // totals have to shrink. 150 is where the full tiles clear the pinned header,
  // so the compact pair takes over exactly as the tiles they replace leave.
  // Releasing at 110 gives a band wide enough that a finger resting near the
  // line cannot flutter the two states against each other.
  // A callback ref, not useRef: the first mount of this panel renders the empty
  // state, which has no scroller, so an effect keyed on [] would attach to
  // nothing and never retry. This re-runs the moment the element appears.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const el = scrollEl;
    if (!el) return;
    // No throttle: the updater returns the same boolean for all but two scroll
    // positions, and React bails out of a re-render when it does.
    const onScroll = () => {
      const y = el.scrollTop;
      setCollapsed((c) => (c ? y > 110 : y > 150));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollEl]);

  if (!node) {
    return (
      <div className="p-4 text-base lg:text-sm text-slate-500">
        Select a tile to inspect it. Double-click a tile to re-center the crawl there.
      </div>
    );
  }

  const slug = node.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  const exportLedgerCsv = async () => {
    setExporting(true);
    try {
      const all = await ledger.fetchAll();
      const header = isSourceRow(all[0] ?? ({} as LedgerRow))
        ? ['counterparty', 'kind', 'industry', 'direction', 'amount', 'transactions', 'first_date', 'last_date']
        : [
            'date',
            'direction',
            'counterparty',
            'industry',
            'amount',
            'type',
            'occupation',
            'address',
            'city',
            'state',
            'zip',
            'source',
          ];

      const lines = all.map((r) =>
        isSourceRow(r)
          ? [r.name, r.kind, r.industry ?? '', r.flow, r.amount, r.txn_count, r.first_date ?? '', r.last_date ?? '']
          : [
              r.txn_date ?? '',
              r.flow,
              r.counterparty_name,
              r.industry ?? '',
              r.amount,
              r.txn_type_code ?? '',
              r.occupation ?? '',
              r.address ?? '',
              r.city ?? '',
              r.state_code ?? '',
              // Quoted by the writer below, so ZIP+4 and leading zeros survive.
              r.zip ?? '',
              r.source_key ?? '',
            ],
      );

      downloadCsv(`${slug}-${view}-${direction}.csv`, toCsv([header, ...lines]));
    } finally {
      setExporting(false);
    }
  };

  // No fetch: the trace is already in hand, so this needs no pending state.
  const exportOriginsCsv = () => {
    if (!traced.result) return;
    const r = traced.result;
    downloadCsv(
      `${slug}-origins${r.cycle ? `-${r.cycle}` : ''}.csv`,
      toCsv([ORIGINS_HEADER, ...originsCsvRows(r)]),
    );
  };

  // Each tab exports its own view, and a tab with nothing loaded cannot export
  // another tab's. Sharing one button without this made the operators tab offer
  // whatever the origins tab had last produced.
  const exporter =
    mode === 'origins'
      ? { run: exportOriginsCsv, ready: traced.result !== null }
      : { run: exportLedgerCsv, ready: !exporting && ledger.total > 0 };

  return (
    <div ref={setScrollEl} className="flex h-full flex-col overflow-y-auto lg:overflow-hidden">
      {/* --------------------------------------------------------- identity */}
      {/* A direct child of the scroller. `sticky` is bounded by its own parent,
          so nested inside the header card below this would scroll away with the
          card rather than pin to the top of the panel. */}
      {/* Phones only from here to the end of the block: on a wide screen the
          name, the kind and the two totals live in the bar over the canvas,
          and repeating them here would cost a third of the panel. */}
      <div
        className="sticky top-0 z-20 shrink-0 border-b border-slate-800 bg-slate-950 px-4 pb-2
                   pt-3 lg:hidden"
      >
        <h3 className="truncate text-base font-semibold leading-snug text-slate-100 lg:whitespace-normal lg:text-sm">
          {node.name}
        </h3>
        <p className={`mt-0.5 text-[13px] text-slate-400 ${collapsed ? 'hidden' : ''}`}>
            {officerHub ? (
              <span className="capitalize">
                {node.office ?? 'officer'}
                {subject && ` · named on ${committeeCount(subject.committees)}`}
              </span>
            ) : (
              <>
                {kindLabel(node)}
                {node.office && ` · ${node.office}`}
                {node.status === 'closed' && ' · closed'}
                {node.city && ` · ${node.city}, ${node.stateCode ?? ''}`}
              </>
            )}
        </p>

        {/* Once the full tiles have scrolled past, the two totals return as one
            line under the name: same buttons, same direction filter, a
            fraction of the height. Phones only. */}
        {collapsed && (
          <div className="mt-1 flex items-baseline gap-4">
            <button
              type="button"
              onClick={() => onDirectionChange('in')}
              className="flex items-baseline gap-1.5"
            >
              <span className="text-[10px] uppercase tracking-wide text-slate-500">In</span>
              <span
                className={`text-[13px] font-semibold tabular-nums ${
                  direction === 'in' ? 'text-emerald-300' : 'text-emerald-400/70'
                }`}
              >
                {formatMoney(received)}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onDirectionChange('out')}
              className="flex items-baseline gap-1.5"
            >
              <span className="text-[10px] uppercase tracking-wide text-slate-500">Out</span>
              <span
                className={`text-[13px] font-semibold tabular-nums ${
                  direction === 'out' ? 'text-amber-300' : 'text-amber-400/70'
                }`}
              >
                {formatMoney(given)}
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Every spelling the state filed for this person. Worth showing: two of
          them are misspellings that keyed apart until corrected. Its own block
          because everything else in the old header card moved to the bar over
          the canvas, and a card holding nothing still draws its border. */}
      {officerHub && subject && subject.spellings.length > 1 && (
        <p
          className="border-b border-slate-800 px-4 pb-3 pt-3 text-[11px] leading-relaxed
                     text-slate-600 lg:shrink-0 lg:text-[10px]"
        >
          Filed as {subject.spellings.join(' · ')}
        </p>
      )}

      {/* ------------------------------------------------------------ header */}
      {/* Phones only. The bar over the canvas carries all of this on a wide
          screen, where it would otherwise cost a third of the panel. */}
      <div className="space-y-3 border-b border-slate-800 px-4 pb-4 pt-3 lg:hidden">
        <div>
          {/* Who runs it. Each name is a link to the other committees naming
              the same person, which is the question it always prompts. */}
          {officers.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {officers.map((o) => (
                <li
                  key={`${o.role}-${o.normalizedName}`}
                  className="flex items-baseline gap-1.5 text-[13px] lg:text-[11px]"
                >
                  <span className="w-14 shrink-0 capitalize text-slate-600">{o.role}</span>
                  <button
                    type="button"
                    onClick={() => onFocus(o.nodeId, { officer: { name: o.fullName, role: o.role } })}

                    className="min-w-0 flex-1 truncate text-left text-slate-300 hover:text-violet-300
                               hover:underline"
                    title="Open this person and everything their committees raised"
                  >
                    {o.fullName}
                  </button>
                  <span
                    className={`shrink-0 tabular-nums ${
                      o.committees >= 25 ? 'text-slate-600' : 'text-violet-400'
                    }`}
                    title={`Named on ${committeeCount(o.committees)}`}
                  >
                    ×{o.committees}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">

          <button
            type="button"
            onClick={() => onDirectionChange('in')}
            className={`rounded border p-2 text-left transition ${
              direction === 'in'
                ? 'border-emerald-600 bg-emerald-950/40'
                : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
            }`}
          >
            <div className="text-[11px] lg:text-[10px] uppercase tracking-wide text-slate-500">Received</div>
            <div className="text-base lg:text-sm font-semibold text-emerald-400">
              {formatMoneyFull(received)}
            </div>
            <div className="text-[11px] lg:text-[10px] text-slate-500">
              {officerHub ? `across ${committeeCount(subject?.committees ?? 0)}` : `${node.inDegree} sources`}
            </div>
          </button>
          <button
            type="button"
            onClick={() => onDirectionChange('out')}
            className={`rounded border p-2 text-left transition ${
              direction === 'out'
                ? 'border-amber-600 bg-amber-950/40'
                : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
            }`}
          >
            <div className="text-[11px] lg:text-[10px] uppercase tracking-wide text-slate-500">Given</div>
            <div className="text-base lg:text-sm font-semibold text-amber-400">
              {formatMoneyFull(given)}
            </div>
            <div className="text-[11px] lg:text-[10px] text-slate-500">
              {officerHub ? `across ${committeeCount(subject?.committees ?? 0)}` : `${node.outDegree} recipients`}
            </div>
          </button>
        </div>

        {/* A hub is a person, and the crawl seeds on an entity id, so there is
            nothing to search out from. */}
        {!officerHub && (
          <button
            type="button"
            onClick={() => onRecenter(node.id)}
            className="w-full rounded bg-indigo-600 px-3 py-2 text-[13px] font-medium text-white
                       hover:bg-indigo-500 lg:text-xs"
          >
            Search from here
          </button>
        )}

      </div>

      {/* --------------------------------------------------- panel identity */}
      {/* Says whose rows these are, at the top of the column holding them. The
          accent runs down the left edge so the answer is legible from the
          canvas without reading: lit means you are looking at something you
          opened, dark means the entity you searched. */}
      <div
        className={`hidden shrink-0 border-b border-l-[3px] border-slate-800 px-3.5 py-[11px]
                    transition-colors duration-200 lg:block ${
                      exploring
                        ? 'border-l-indigo-500 bg-indigo-950/25'
                        : 'border-l-slate-700 bg-transparent'
                    }`}
      >
        <span className="block text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">
          Details for
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: kindColor(node.kind) }}
            aria-hidden
          />
          <span className="truncate text-[13px] font-semibold text-slate-100" title={node.name}>
            {node.name}
          </span>
        </span>
        {showLedger && (
          <span className="block truncate text-[10.5px] text-slate-400">
            {ledger.total.toLocaleString()}{' '}
            {view === 'sources'
              ? direction === 'out'
                ? 'recipients'
                : 'counterparties'
              : 'transactions'}
            {q && ' matching'} · {formatMoneyFull(ledger.totalAmount)}
          </span>
        )}
      </div>

      {/* ------------------------------------------------------------ controls */}
      <div className="space-y-2 border-b border-slate-800 p-3 lg:shrink-0">
        <div className="grid grid-cols-3 gap-1">
          {DIRECTIONS.map((d) => (
            <button
              key={d.value}
              type="button"
              onClick={() => onDirectionChange(d.value)}

              className={`rounded px-2 py-1 text-[13px] lg:text-[11px] font-medium transition ${
                direction === d.value
                  ? 'bg-slate-700 text-slate-100'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-1">
          {PANEL_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => {
                setMode(m.value);
                setSort(defaultSortFor(m.value));
              }}
              title={m.hint}
              className={`rounded px-1.5 py-1 text-[13px] lg:text-[11px] font-medium leading-tight transition ${
                mode === m.value
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {showLedger && (
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by name…"
          className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[13px] lg:text-xs
                     text-slate-100 placeholder-slate-600 outline-none focus:border-indigo-500"
        />
        )}

        {/* Not gated on the tab: this narrows the graph rather than these
            rows, so hiding it on the origins tab would make a setting that is
            still in force disappear. Labelled for the same reason — the rows
            beside it are the whole ledger either way. */}
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-600">
              Graph from
            </span>
            <input
              type="date"
              value={dateFrom ?? ''}
              onChange={(e) => onDatesChange(e.target.value || undefined, dateTo)}
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[13px]
                         text-slate-100 outline-none focus:border-indigo-500 lg:text-xs"
            />
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-600">
              Graph to
            </span>
            <input
              type="date"
              value={dateTo ?? ''}
              onChange={(e) => onDatesChange(dateFrom, e.target.value || undefined)}
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[13px]
                         text-slate-100 outline-none focus:border-indigo-500 lg:text-xs"
            />
          </label>
        </div>


        {/* Export stays put across tabs; only the sort is ledger-only. */}
        <div className="flex items-center justify-between gap-2">
          {showLedger && (
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as LedgerSort)}
              className="rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-[13px] lg:text-[11px]
                         text-slate-300 outline-none focus:border-indigo-500"
            >
              <option value="amount">Largest first</option>
              <option value="date">Most recent</option>
              <option value="name">Name A–Z</option>
              {view === 'sources' && <option value="count">Most transactions</option>}
            </select>
          )}
          <button
            type="button"
            onClick={exporter.run}
            disabled={!exporter.ready}
            className="ml-auto rounded border border-slate-700 px-2 py-1 text-[13px] lg:text-[11px] text-slate-300
                       hover:bg-slate-800 disabled:opacity-40"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>

        {/* Reconciles against the tile totals above. Repeated by the panel's
            own header on a wide screen, which is where the eye goes first;
            this is the phone's copy. */}
        {showLedger && (
        <div className="flex items-baseline justify-between text-[13px] lg:hidden">

          <span className="text-slate-400">
            {ledger.total.toLocaleString()}{' '}
            {view === 'sources'
              ? direction === 'out'
                ? 'recipients'
                : 'counterparties'
              : 'transactions'}
            {q && ' matching'}
          </span>
          <span
            className={
              direction === 'out'
                ? 'font-semibold text-amber-400'
                : direction === 'in'
                  ? 'font-semibold text-emerald-400'
                  : 'font-semibold text-slate-300'
            }
          >
            {formatMoneyFull(ledger.totalAmount)}
          </span>
        </div>
        )}

        {/* Money shuffled between committees in the set. Real, but it neither
            entered nor left the group, so a headline that includes it
            overstates what was raised — say so rather than net it away. */}
        {showLedger && Number(ledger.internalAmount) > 0 && (
          <p className="text-[11px] lg:text-[10px] leading-relaxed text-amber-500/80">
            {formatMoneyFull(ledger.internalAmount)} of that moved between committees in this
            group. It is real money but did not enter or leave the network, so subtract it before
            quoting a total raised.
          </p>
        )}
      </div>

      {/* ------------------------------------------------------------ rows */}
      <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {mode === 'origins' && (
          <OriginsReport
            state={traced}
            dateOrdered={dateOrdered}
            onToggleDateOrdered={() => setDateOrdered((v) => !v)}
            onFocus={onFocus}
            nodes={nodes}
          />
        )}

        {showLedger && (<>
        {ledger.error && <p className="p-3 text-[13px] lg:text-xs text-red-400">{ledger.error}</p>}

        {!ledger.loading && ledger.rows.length === 0 && (
          <p className="p-3 text-[13px] lg:text-xs text-slate-600">
            {q ? 'No matches.' : 'Nothing recorded in this direction.'}
          </p>
        )}

        <ul className="divide-y divide-slate-800/60">
          {ledger.rows.map((r) => {
            const target = rowTarget(r);
            return (
              <LedgerRowItem
                key={isSourceRow(r) ? `${r.entity_id}-${r.flow}` : r.id}
                row={r}
                onFocus={onFocus}
                inGraph={target !== null && nodes.has(target)}
              />
            );
          })}
        </ul>

        {ledger.hasMore && (
          <button
            type="button"
            onClick={ledger.loadMore}
            disabled={ledger.loading}
            className="w-full py-2 text-[13px] lg:text-xs text-indigo-400 hover:bg-slate-900 disabled:opacity-50"
          >
            {ledger.loading
              ? 'Loading…'
              : `Load ${Math.min(100, ledger.total - ledger.rows.length)} more of ${ledger.total.toLocaleString()}`}
          </button>
        )}

        {ledger.loading && ledger.rows.length === 0 && (
          <p className="p-3 text-[13px] lg:text-xs text-slate-500">Loading…</p>
        )}
        </>)}
      </div>
    </div>
  );
}

/** RFC 4180: quote every field, double any embedded quote. */
function toCsv(rows: (string | number)[][]): string {
  return rows
    .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const ORIGINS_HEADER = [
  'category',
  'name',
  'industry',
  'kind',
  'hops_away',
  'amount',
  'share',
  'share_of',
  'counts_toward_total',
  'entity_id',
  'notes',
];

/**
 * Flatten a trace into rows.
 *
 * The report is not a table: it holds traced sources, the national pools money
 * arrived through, those pools' own funders, dead ends, and a residual. Left as
 * a bare list of names and dollars, the pool funders are the trap — their
 * amounts are national money and their shares are shares *of the pool*, so a
 * reader summing the amount column or multiplying two percentages together gets
 * a number no filing supports. `share_of` names the denominator on every row and
 * `counts_toward_total` marks what belongs in the seed's accounting, so the
 * distinction survives leaving the screen.
 */
function originsCsvRows(r: TraceResult): (string | number)[][] {
  const seed = r.seed.name;
  const money = (n: number) => n.toFixed(2);
  const share = (n: number) => n.toFixed(6);

  const rows: (string | number)[][] = [
    [
      'seed',
      seed,
      // Not a donor — this is the trace's own destination, not one of its sources.
      '',
      r.seed.kind,
      '',
      money(r.seed.total),
      share(1),
      seed,
      'yes',
      r.seed.id,
      [
        r.cycle ? `cycle ${r.cycle}` : 'all cycles',
        `traced ${r.hops} hops`,
        r.dateOrdered
          ? 'only credits money a conduit held before it paid out'
          : 'no date ordering',
        r.truncated ? 'hit the strand ceiling — some paths fell into the long tail' : null,
      ]
        .filter(Boolean)
        .join(' · '),
    ],
  ];

  for (const s of r.sources) {
    rows.push([
      'traced',
      s.name,
      s.industry ?? '',
      s.kind,
      s.hop,
      money(s.amount),
      share(s.share),
      seed,
      'yes',
      s.id,
      '',
    ]);
  }

  for (const p of r.injectionPoints) {
    rows.push([
      'national_pool',
      p.name,
      p.industry ?? '',
      p.kind,
      p.hop,
      money(p.amount),
      share(p.share),
      seed,
      'yes',
      p.id,
      'Raised nationally and spent across many states; no filing says what share reached Florida.',
    ]);
    for (const f of p.funders) {
      rows.push([
        'pool_funder',
        f.name,
        f.industry ?? '',
        '',
        '',
        money(f.amount),
        share(f.share),
        p.name,
        'no',
        f.id,
        `Share of ${p.name}, not of ${seed}. Do not multiply by the pool's share or add to the total.`,
      ]);
    }
  }

  for (const u of r.unresolved) {
    rows.push([
      'trail_end',
      u.name,
      u.industry ?? '',
      u.kind,
      u.hop,
      money(u.amount),
      share(u.share),
      seed,
      'yes',
      u.id,
      'No recorded upstream in this data.',
    ]);
  }

  if (r.dispersed > 0) {
    rows.push([
      'long_tail',
      '',
      '',
      '',
      '',
      money(r.dispersed),
      share(r.seed.total > 0 ? r.dispersed / r.seed.total : 0),
      seed,
      'yes',
      '',
      'Strands abandoned below the minimum, or pruned at the parcel ceiling.',
    ]);
  }

  return rows;
}

/**
 * Where this entity's money came from, past the conduits.
 *
 * Presented apart from the ledger because it answers a different question. The
 * ledger says who wrote the cheque; for a committee funded by other committees
 * that is routinely not who paid. The unresolved and dispersed figures are
 * shown alongside the sources on purpose — a list of origins accounting for a
 * quarter of the money reads as an answer unless the rest is on screen too.
 */
function OriginsReport({
  state,
  dateOrdered,
  onToggleDateOrdered,
  onFocus,
  nodes,
}: {
  state: { result: TraceResult | null; loading: boolean; error: string | null };
  dateOrdered: boolean;
  onToggleDateOrdered: () => void;
  onFocus: (nodeId: string, link?: FocusLink) => void;
  nodes: Map<string, GraphNode>;
}) {
  if (state.error) return <p className="p-3 text-[13px] lg:text-xs text-red-400">{state.error}</p>;
  if (state.loading && !state.result) {
    return <p className="p-3 text-[13px] lg:text-xs text-slate-500">Following the money…</p>;
  }
  if (!state.result) return null;

  const r = state.result;
  const attributed = r.sources.reduce((a, b) => a + b.amount, 0);
  const viaPools = r.injectionPoints.reduce((a, b) => a + b.amount, 0);
  const unresolved = r.unresolved.reduce((a, b) => a + b.amount, 0);
  const pct = (n: number) => (r.seed.total > 0 ? (n / r.seed.total) * 100 : 0);

  const bar = (label: string, value: number, className: string) => (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[11px] lg:text-[10px] text-slate-500">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-800">
        <div className={`h-full ${className}`} style={{ width: `${pct(value)}%` }} />
      </div>
      <span className="w-24 shrink-0 text-right text-[11px] lg:text-[10px] tabular-nums text-slate-400">
        {formatMoney(String(value))} · {pct(value).toFixed(0)}%
      </span>
    </div>
  );

  return (
    <div>
      <div className="space-y-2 border-b border-slate-800 p-3">
        <div className="space-y-1">
          {bar('Traced', attributed, 'bg-emerald-500')}
          {viaPools > 0 && bar('National pool', viaPools, 'bg-sky-500')}
          {bar('Unresolved', unresolved, 'bg-slate-500')}
          {bar('Long tail', r.dispersed, 'bg-slate-700')}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[11px] lg:text-[10px] text-slate-400">
          <input
            type="checkbox"
            checked={dateOrdered}
            onChange={onToggleDateOrdered}
            className="accent-indigo-500"
          />
          Only credit money a conduit held before it paid out
        </label>
        <p className="text-[11px] lg:text-[10px] leading-relaxed text-slate-600">
          Pro-rata across {r.hops} hops: what share of the pool each source funded, not the route a
          particular dollar took.
          {r.truncated && ' Hit the strand ceiling — some paths folded into the long tail.'}
        </p>
      </div>

      {r.sources.length === 0 && (
        <p className="p-3 text-[13px] lg:text-xs text-slate-600">
          No originating sources found. Every path ends at a committee with no recorded upstream.
        </p>
      )}

      <ul className="divide-y divide-slate-800/60">
        {r.sources.map((s) => (
          <li key={s.id} className="hover:bg-slate-800/50">
            <button
              type="button"
              onClick={() => onFocus(s.id, { chain: s.chain, label: 'traced', flow: 'in' })}
              className="flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] lg:text-xs text-slate-200">{s.name}</span>
                  {nodes.has(s.id) && (
                    <span className="shrink-0 text-[9px] text-indigo-400" title="On the canvas">
                      ●
                    </span>
                  )}
                </span>
                <span className="block truncate text-[11px] lg:text-[10px] text-slate-500">
                  {s.kind} · {s.hop} hop{s.hop === 1 ? '' : 's'} away
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-[13px] lg:text-xs font-medium tabular-nums text-emerald-400">
                  {formatMoney(String(s.amount))}
                </span>
                <span className="block text-[11px] lg:text-[10px] tabular-nums text-slate-500">
                  {(s.share * 100).toFixed(1)}%
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {r.injectionPoints.map((p) => (
        <div key={p.id} className="border-t border-sky-900/60 bg-sky-950/20">
          <div className="px-3 pb-1 pt-2">
            <p className="text-[11px] lg:text-[10px] uppercase tracking-wide text-sky-400">
              Entered Florida through a national pool
            </p>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <button
                type="button"
                onClick={() => onFocus(p.id, { chain: p.chain, label: 'traced', flow: 'in' })}
                className="min-w-0 flex-1 truncate text-left text-[13px] lg:text-xs text-slate-200 hover:underline"
              >
                {p.name}
              </button>
              <span className="shrink-0 text-[13px] lg:text-xs font-medium tabular-nums text-sky-300">
                {formatMoney(String(p.amount))} · {(p.share * 100).toFixed(1)}%
              </span>
            </div>
            {/* Shares are of the pool, never of the seed: how much of this
                pool reached Florida is not disclosed anywhere. */}
            <p className="mt-1 text-[11px] lg:text-[10px] leading-relaxed text-slate-500">
              Raised nationally and spent across many states. Its own funders are below, as
              shares of <em>its</em> money — not of {r.seed.name}. The two cannot be multiplied
              together, because no filing says which share of this pool came to Florida.
            </p>
          </div>
          <ul className="divide-y divide-slate-800/60">
            {p.funders.map((f) => (
              <li key={f.id} className="hover:bg-slate-800/50">
                <button
                  type="button"
                  // The pool's own funder, so the route runs through the pool:
                  // one hop further out than the pool's own.
                  onClick={() =>
                    onFocus(f.id, { chain: [...p.chain, f.id], label: 'traced', flow: 'in' })
                  }
                  className="flex w-full items-baseline justify-between gap-2 px-3 py-1 text-left"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] lg:text-[11px] text-slate-300">
                    {f.name}
                  </span>
                  <span className="shrink-0 text-[13px] lg:text-[11px] tabular-nums text-slate-400">
                    {formatMoney(String(f.amount))}
                  </span>
                  <span className="w-10 shrink-0 text-right text-[11px] lg:text-[10px] tabular-nums text-slate-500">
                    {(f.share * 100).toFixed(1)}%
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {r.unresolved.length > 0 && (
        <div className="border-t border-slate-800">
          <p className="px-3 pb-1 pt-2 text-[11px] lg:text-[10px] uppercase tracking-wide text-slate-500">
            Trail ends here
          </p>
          <ul className="divide-y divide-slate-800/60">
            {r.unresolved.map((s) => (
              <li key={s.id} className="hover:bg-slate-800/50">
                <button
                  type="button"
                  onClick={() => onFocus(s.id, { chain: s.chain, label: 'traced', flow: 'in' })}
                  className="flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] lg:text-xs text-slate-300">{s.name}</span>
                    <span className="block truncate text-[11px] lg:text-[10px] text-slate-600">
                      no recorded upstream in this data
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-[13px] lg:text-xs font-medium tabular-nums text-slate-400">
                      {formatMoney(String(s.amount))}
                    </span>
                    <span className="block text-[11px] lg:text-[10px] tabular-nums text-slate-600">
                      {(s.share * 100).toFixed(1)}%
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Assemble a contributor's mailing address from the parts the state reports.
 *
 * Every part is independently optional — plenty of rows have a city and no
 * street, and a few have neither — so this drops empties rather than emitting
 * stray commas.
 */
function formatAddress(row: LedgerRow): string {
  if (isSourceRow(row)) return '';
  const cityState = [row.city, [row.state_code, row.zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [row.address, cityState].filter(Boolean).join(' · ');
}

/**
 * The entity a row points at, or null when there is nowhere to go.
 *
 * An aggregated row is a counterparty by definition. A transaction row is not
 * itself a node, but the party it names is the same entity the aggregated view
 * would link to — so both navigate. Only an unresolved counterparty has no
 * target.
 */
function rowTarget(row: LedgerRow): string | null {
  return isSourceRow(row) ? row.entity_id : row.counterparty_id;
}

function LedgerRowItem({
  row,
  onFocus,
  inGraph,
}: {
  row: LedgerRow;
  onFocus: (nodeId: string, link?: FocusLink) => void;
  inGraph: boolean;
}) {
  const source = isSourceRow(row);
  const name = source ? row.name : row.counterparty_name;
  const amountColor = row.flow === 'in' ? 'text-emerald-400' : 'text-amber-400';

  const body = (
    <div className="flex items-start justify-between gap-2 px-3 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] lg:text-xs text-slate-200">{name}</span>
          {source && row.is_self && (
            <span className="shrink-0 rounded bg-slate-800 px-1 text-[9px] text-slate-400">
              self
            </span>
          )}
          {inGraph && (
            <span
              className="shrink-0 text-[9px] text-indigo-400"
              title="Currently drawn on the canvas"
            >
              ●
            </span>
          )}
        </span>
        <span className="block truncate text-[11px] lg:text-[10px] text-slate-500">
          {source
            ? `${row.kind}${row.txn_count > 1 ? ` · ${row.txn_count} transactions` : ''}${
                row.last_date ? ` · ${row.last_date}` : ''
              }`
            : [row.txn_date, row.txn_type_code, row.occupation].filter(Boolean).join(' · ')}
        </span>
        {/* The mailing address earns its own line: on one line it pushed the
            date and occupation out of a row this narrow. */}
        {!source && formatAddress(row) && (
          <span className="block truncate text-[11px] lg:text-[10px] text-slate-600" title={formatAddress(row)}>
            {formatAddress(row)}
          </span>
        )}
      </span>
      <span className={`shrink-0 text-[13px] lg:text-xs font-medium tabular-nums ${amountColor}`}>
        {row.flow === 'out' ? '−' : ''}
        {formatMoney(row.amount)}
      </span>
    </div>
  );

  // Both shapes name a party worth opening. A row whose counterparty never
  // resolved stays inert, and drops the hover highlight with it: an unclickable
  // row that lights up under the cursor reads as broken rather than as absent.
  const target = rowTarget(row);

  return (
    <li className={target ? 'hover:bg-slate-800/50' : ''}>
      {target ? (
        <button
          type="button"
          // No chain: the row is a hop off the entity on screen, and the parent
          // knows which one that is. The amount labels the hop where it has to
          // be drawn in.
          onClick={() => onFocus(target, { label: formatMoney(row.amount), flow: row.flow })}

          className="w-full text-left"
        >

          {body}
        </button>
      ) : (
        body
      )}
    </li>
  );
}
