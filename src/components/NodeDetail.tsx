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

import { useMemo, useState } from 'react';
import {
  formatMoney,
  formatMoneyFull,
  kindLabel,
  type GraphNode,
} from '@/lib/graph/types';
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
  onFocus: (nodeId: string) => void;
  onRecenter: (nodeId: string) => void;
}

const DIRECTIONS: { value: LedgerDirection; label: string }[] = [
  { value: 'in', label: 'Money in' },
  { value: 'out', label: 'Money out' },
  { value: 'all', label: 'Both' },
];

export default function NodeDetail({ node, nodes, onFocus, onRecenter }: Props) {
  const [view, setView] = useState<LedgerView>('sources');
  const [direction, setDirection] = useState<LedgerDirection>('in');
  const [sort, setSort] = useState<LedgerSort>('amount');
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);

  const query = useMemo(() => ({ view, direction, q, sort }), [view, direction, q, sort]);
  const ledger = useLedger(node?.id ?? null, query);

  if (!node) {
    return (
      <div className="p-4 text-sm text-slate-500">
        Select a tile to inspect it. Double-click a tile to re-center the crawl there.
      </div>
    );
  }

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await ledger.fetchAll();
      const header = isSourceRow(all[0] ?? ({} as LedgerRow))
        ? ['counterparty', 'kind', 'direction', 'amount', 'transactions', 'first_date', 'last_date']
        : [
            'date',
            'direction',
            'counterparty',
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
          ? [r.name, r.kind, r.flow, r.amount, r.txn_count, r.first_date ?? '', r.last_date ?? '']
          : [
              r.txn_date ?? '',
              r.flow,
              r.counterparty_name,
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

      const csv = [header, ...lines]
        .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
        .join('\n');

      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${node.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${view}-${direction}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* ------------------------------------------------------------ header */}
      <div className="shrink-0 space-y-3 border-b border-slate-800 p-4">
        <div>
          <h3 className="text-sm font-semibold leading-snug text-slate-100">{node.name}</h3>
          <p className="mt-0.5 text-xs text-slate-400">
            {kindLabel(node)}
            {node.office && ` · ${node.office}`}
            {node.status === 'closed' && ' · closed'}
            {node.city && ` · ${node.city}, ${node.stateCode ?? ''}`}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setDirection('in')}
            className={`rounded border p-2 text-left transition ${
              direction === 'in'
                ? 'border-emerald-600 bg-emerald-950/40'
                : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
            }`}
          >
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Received</div>
            <div className="text-sm font-semibold text-emerald-400">
              {formatMoneyFull(node.totalReceived)}
            </div>
            <div className="text-[10px] text-slate-500">{node.inDegree} sources</div>
          </button>
          <button
            type="button"
            onClick={() => setDirection('out')}
            className={`rounded border p-2 text-left transition ${
              direction === 'out'
                ? 'border-amber-600 bg-amber-950/40'
                : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
            }`}
          >
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Given</div>
            <div className="text-sm font-semibold text-amber-400">
              {formatMoneyFull(node.totalGiven)}
            </div>
            <div className="text-[10px] text-slate-500">{node.outDegree} recipients</div>
          </button>
        </div>

        <button
          type="button"
          onClick={() => onRecenter(node.id)}
          className="w-full rounded bg-indigo-600 px-3 py-2 text-xs font-medium text-white
                     hover:bg-indigo-500"
        >
          Re-center crawl here
        </button>
      </div>

      {/* ------------------------------------------------------------ controls */}
      <div className="shrink-0 space-y-2 border-b border-slate-800 p-3">
        <div className="grid grid-cols-3 gap-1">
          {DIRECTIONS.map((d) => (
            <button
              key={d.value}
              type="button"
              onClick={() => setDirection(d.value)}
              className={`rounded px-2 py-1 text-[11px] font-medium transition ${
                direction === d.value
                  ? 'bg-slate-700 text-slate-100'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-1">
          {(['sources', 'transactions'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`rounded px-2 py-1 text-[11px] font-medium capitalize transition ${
                view === v
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {v === 'sources' ? 'By counterparty' : 'Every transaction'}
            </button>
          ))}
        </div>

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by name…"
          className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs
                     text-slate-100 placeholder-slate-600 outline-none focus:border-indigo-500"
        />

        <div className="flex items-center justify-between gap-2">
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as LedgerSort)}
            className="rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-[11px]
                       text-slate-300 outline-none focus:border-indigo-500"
          >
            <option value="amount">Largest first</option>
            <option value="date">Most recent</option>
            <option value="name">Name A–Z</option>
            {view === 'sources' && <option value="count">Most transactions</option>}
          </select>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting || ledger.total === 0}
            className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300
                       hover:bg-slate-800 disabled:opacity-40"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>

        {/* Reconciles against the tile totals above. */}
        <div className="flex items-baseline justify-between text-[11px]">
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
      </div>

      {/* ------------------------------------------------------------ rows */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ledger.error && <p className="p-3 text-xs text-red-400">{ledger.error}</p>}

        {!ledger.loading && ledger.rows.length === 0 && (
          <p className="p-3 text-xs text-slate-600">
            {q ? 'No matches.' : 'Nothing recorded in this direction.'}
          </p>
        )}

        <ul className="divide-y divide-slate-800/60">
          {ledger.rows.map((r) => (
            <LedgerRowItem
              key={isSourceRow(r) ? `${r.entity_id}-${r.flow}` : r.id}
              row={r}
              onFocus={onFocus}
              inGraph={isSourceRow(r) ? nodes.has(r.entity_id) : false}
            />
          ))}
        </ul>

        {ledger.hasMore && (
          <button
            type="button"
            onClick={ledger.loadMore}
            disabled={ledger.loading}
            className="w-full py-2 text-xs text-indigo-400 hover:bg-slate-900 disabled:opacity-50"
          >
            {ledger.loading
              ? 'Loading…'
              : `Load ${Math.min(100, ledger.total - ledger.rows.length)} more of ${ledger.total.toLocaleString()}`}
          </button>
        )}

        {ledger.loading && ledger.rows.length === 0 && (
          <p className="p-3 text-xs text-slate-500">Loading…</p>
        )}
      </div>
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

function LedgerRowItem({
  row,
  onFocus,
  inGraph,
}: {
  row: LedgerRow;
  onFocus: (nodeId: string) => void;
  inGraph: boolean;
}) {
  const source = isSourceRow(row);
  const name = source ? row.name : row.counterparty_name;
  const amountColor = row.flow === 'in' ? 'text-emerald-400' : 'text-amber-400';

  const body = (
    <div className="flex items-start justify-between gap-2 px-3 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs text-slate-200">{name}</span>
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
        <span className="block truncate text-[10px] text-slate-500">
          {source
            ? `${row.kind}${row.txn_count > 1 ? ` · ${row.txn_count} transactions` : ''}${
                row.last_date ? ` · ${row.last_date}` : ''
              }`
            : [row.txn_date, row.txn_type_code, row.occupation].filter(Boolean).join(' · ')}
        </span>
        {/* The mailing address earns its own line: on one line it pushed the
            date and occupation out of a row this narrow. */}
        {!source && formatAddress(row) && (
          <span className="block truncate text-[10px] text-slate-600" title={formatAddress(row)}>
            {formatAddress(row)}
          </span>
        )}
      </span>
      <span className={`shrink-0 text-xs font-medium tabular-nums ${amountColor}`}>
        {row.flow === 'out' ? '−' : ''}
        {formatMoney(row.amount)}
      </span>
    </div>
  );

  // Counterparty rows navigate; individual transactions are not themselves nodes.
  return (
    <li className="hover:bg-slate-800/50">
      {source ? (
        <button type="button" onClick={() => onFocus(row.entity_id)} className="w-full text-left">
          {body}
        </button>
      ) : (
        body
      )}
    </li>
  );
}
