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
import { useTrace, type TraceResult } from '@/lib/graph/useTrace';
import {
  useAffiliations,
  type AffiliationCluster,
  type AffiliationResult,
} from '@/lib/graph/useAffiliations';
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
  /** Draw these entities alongside the current graph, without re-crawling. */
  onAddToCanvas: (entityIds: string[]) => void;
  /** Election cycle the graph is filtered to, or undefined for all. */
  cycle?: string;
}

const DIRECTIONS: { value: LedgerDirection; label: string }[] = [
  { value: 'in', label: 'Money in' },
  { value: 'out', label: 'Money out' },
  { value: 'all', label: 'Both' },
];

type PanelMode = 'sources' | 'transactions' | 'origins' | 'operators';

const PANEL_MODES: { value: PanelMode; label: string; hint: string }[] = [
  { value: 'sources', label: 'By counterparty', hint: 'One row per counterparty, aggregated.' },
  { value: 'transactions', label: 'Every transaction', hint: 'One row per reported line item.' },
  {
    value: 'origins',
    label: 'Funding origins',
    hint: 'Follow the money past committee-to-committee transfers to whoever originated it.',
  },
  {
    value: 'operators',
    label: 'Who runs this',
    hint: 'Registration on file, and which other committees name the same people or address.',
  },
];

export default function NodeDetail({
  node,
  nodes,
  onFocus,
  onRecenter,
  onAddToCanvas,
  cycle,
}: Props) {
  const [mode, setMode] = useState<PanelMode>('sources');
  const [direction, setDirection] = useState<LedgerDirection>('in');
  const [sort, setSort] = useState<LedgerSort>('amount');
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);
  const [dateOrdered, setDateOrdered] = useState(true);

  // The origins and operators tabs ask different questions of the same entity,
  // so the ledger keeps its last view rather than being torn down and refetched
  // on return.
  const view: LedgerView = mode === 'origins' || mode === 'operators' ? 'sources' : mode;
  const showLedger = mode === 'sources' || mode === 'transactions';

  const query = useMemo(
    () => ({ view, direction, q, sort, cycle }),
    [view, direction, q, sort, cycle],
  );
  const ledger = useLedger(node?.id ?? null, query);
  const traceQuery = useMemo(
    () => ({ depth: 12, min: 100, dateOrdered, cycle }),
    [dateOrdered, cycle],
  );
  const traced = useTrace(node?.id ?? null, traceQuery, mode === 'origins');
  const operators = useAffiliations(node?.id ?? null, mode === 'operators');

  if (!node) {
    return (
      <div className="p-4 text-sm text-slate-500">
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

  const exportOperatorsCsv = () => {
    if (!operators.result) return;
    downloadCsv(`${slug}-operators.csv`, toCsv([OPERATORS_HEADER, ...operatorsCsvRows(operators.result)]));
  };

  // Each tab exports its own view, and a tab with nothing loaded cannot export
  // another tab's. Sharing one button without this made the operators tab offer
  // whatever the origins tab had last produced.
  const exporter =
    mode === 'operators'
      ? { run: exportOperatorsCsv, ready: operators.result !== null }
      : mode === 'origins'
        ? { run: exportOriginsCsv, ready: traced.result !== null }
        : { run: exportLedgerCsv, ready: !exporting && ledger.total > 0 };

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
          {PANEL_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode(m.value)}
              title={m.hint}
              className={`rounded px-2 py-1 text-[11px] font-medium transition ${
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
          className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs
                     text-slate-100 placeholder-slate-600 outline-none focus:border-indigo-500"
        />
        )}

        {/* Export stays put across tabs; only the sort is ledger-only. */}
        <div className="flex items-center justify-between gap-2">
          {showLedger && (
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
          )}
          <button
            type="button"
            onClick={exporter.run}
            disabled={!exporter.ready}
            className="ml-auto rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300
                       hover:bg-slate-800 disabled:opacity-40"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>

        {/* Reconciles against the tile totals above. */}
        {showLedger && (
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
        )}
      </div>

      {/* ------------------------------------------------------------ rows */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === 'origins' && (
          <OriginsReport
            state={traced}
            dateOrdered={dateOrdered}
            onToggleDateOrdered={() => setDateOrdered((v) => !v)}
            onFocus={onFocus}
            nodes={nodes}
          />
        )}

        {mode === 'operators' && (
          <OperatorsReport
            state={operators}
            onFocus={onFocus}
            onAddToCanvas={onAddToCanvas}
            nodes={nodes}
          />
        )}

        {showLedger && (<>
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
        </>)}
      </div>
    </div>
  );
}

/**
 * Who a committee says runs it, and who else says the same.
 *
 * The panel's job is to make a shared name usable without letting it be
 * misread, and those pull in opposite directions. A shared treasurer looks
 * damning and is usually mundane: 65% of Florida's active committees share one
 * with somebody, and the largest single treasurer holds 278 of them while
 * running a compliance practice rather than a network.
 *
 * So the count is never optional. Every shared attribute leads with how many
 * committees share it, large clusters are labelled as the service providers
 * they almost certainly are and start collapsed, and small ones — where the
 * signal actually lives — open by default. The wording stays at what the
 * filings say: *names the same treasurer*, never *is controlled by*.
 */
function OperatorsReport({
  state,
  onFocus,
  onAddToCanvas,
  nodes,
}: {
  state: { result: AffiliationResult | null; loading: boolean; error: string | null };
  onFocus: (nodeId: string) => void;
  onAddToCanvas: (entityIds: string[]) => void;
  nodes: Map<string, GraphNode>;
}) {
  if (state.error) return <p className="p-3 text-xs text-red-400">{state.error}</p>;
  if (state.loading && !state.result) {
    return <p className="p-3 text-xs text-slate-500">Reading the registration…</p>;
  }
  if (!state.result) return null;

  const r = state.result;

  if (r.unregistered) {
    return (
      <div className="space-y-2 p-3">
        <p className="text-xs text-slate-400">No registration on file for this entity.</p>
        <p className="text-[10px] leading-relaxed text-slate-600">
          Only state-registered committees are loaded. County committees publish an address and
          phone on their own filing pages, and name their officers only inside scanned appointment
          forms, so neither is here yet. Candidates and donors have no registration at all.
        </p>
      </div>
    );
  }

  return (
    <div>
      {r.registration && (
        <div className="space-y-2 border-b border-slate-800 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">As registered</p>
            {r.registration.externalId && (
              <span
                className="shrink-0 text-[10px] tabular-nums text-slate-500"
                title="The filing office's own account number"
              >
                acct {r.registration.externalId}
              </span>
            )}
          </div>
          <div className="space-y-0.5 text-xs text-slate-300">
            {r.registration.addressLines.map((line) => (
              <div key={line}>{line}</div>
            ))}
            {r.registration.cityStateZip && (
              <div>{formatZipInPlace(r.registration.cityStateZip)}</div>
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
            {r.registration.phone && <span>{formatPhone(r.registration.phone)}</span>}
            {r.registration.countyName && <span>{r.registration.countyName} County</span>}
            {r.registration.typeDescription && <span>{r.registration.typeDescription}</span>}
          </div>
          {(r.registration.email || r.registration.website) && (
            <div className="space-y-0.5 text-[10px] text-slate-500">
              {r.registration.email && <div className="truncate">{r.registration.email}</div>}
              {r.registration.website && <div className="truncate">{r.registration.website}</div>}
            </div>
          )}
        </div>
      )}

      {r.officers.length > 0 && (
        <div className="border-b border-slate-800 p-3">
          <p className="mb-1.5 text-[10px] uppercase tracking-wide text-slate-500">
            Named on the filings
          </p>
          <ul className="space-y-1">
            {r.officers.map((o) => (
              <li key={`${o.role}-${o.normalizedName}`} className="flex items-baseline gap-2">
                <span className="w-16 shrink-0 text-[10px] capitalize text-slate-500">
                  {o.role.replace(/_/g, ' ')}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{o.fullName}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.clusters.length === 0 ? (
        <p className="p-3 text-xs text-slate-600">
          Nothing shared with another committee — this address, phone and officers appear on no
          other registration we hold.
        </p>
      ) : (
        <>
          <p className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-slate-500">
            Also appears on other committees
          </p>
          {r.clusters.map((c) => (
            <ClusterBlock
              key={`${c.basis}-${c.value}`}
              cluster={c}
              onFocus={onFocus}
              onAddToCanvas={onAddToCanvas}
              nodes={nodes}
            />
          ))}
          <p className="px-3 pb-3 pt-1 text-[10px] leading-relaxed text-slate-600">
            These are shared registration details, not payments. Nothing here is drawn as an edge
            and nothing here is followed by a funding trace — two committees sharing a treasurer
            have not, on that evidence, sent each other anything.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Present a phone number and a ZIP the way a person writes them.
 *
 * The state stores both unpunctuated — "4075871437", "328225017" — which is
 * right for matching and unreadable on screen. Anything that is not the
 * expected length is passed through untouched rather than mangled.
 */
function formatPhone(raw: string | null): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D+/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith('1')) return formatPhone(d.slice(1));
  return raw;
}

function formatZipInPlace(cityStateZip: string | null): string | null {
  if (!cityStateZip) return null;
  return cityStateZip.replace(/\b(\d{5})(\d{4})\b/, '$1-$2');
}

const BASIS_LABEL: Record<AffiliationCluster['basis'], string> = {
  chair: 'names the same chair',
  treasurer: 'names the same treasurer',
  address: 'files from the same address',
  phone: 'lists the same phone',
};

function ClusterBlock({
  cluster,
  onFocus,
  onAddToCanvas,
  nodes,
}: {
  cluster: AffiliationCluster;
  onFocus: (nodeId: string) => void;
  onAddToCanvas: (entityIds: string[]) => void;
  nodes: Map<string, GraphNode>;
}) {
  // Small clusters are the finding; big ones are a vendor's client list. Opening
  // the interesting one and folding the noisy one away is the whole point.
  const [open, setOpen] = useState(!cluster.isVendorScale);
  const others = cluster.total - 1;
  const undrawn = cluster.peers.filter((p) => !nodes.has(p.id));

  return (
    <div className="border-t border-slate-800/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left
                   hover:bg-slate-800/50"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-slate-200">
            {cluster.basis === 'phone' ? formatPhone(cluster.label) : cluster.label}
          </span>
          <span className="block text-[10px] text-slate-500">
            {BASIS_LABEL[cluster.basis]} as {others} other{others === 1 ? '' : 's'}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span
            className={`block text-xs font-semibold tabular-nums ${
              cluster.isVendorScale ? 'text-slate-400' : 'text-indigo-300'
            }`}
          >
            {cluster.total}
          </span>
          <span className="block text-[9px] text-slate-600">{open ? 'hide' : 'show'}</span>
        </span>
      </button>

      {/* A restatement of the count, for scanning several clusters at once. */}
      <div className="px-3 pb-1.5">
        <div className="h-1 overflow-hidden rounded bg-slate-800">
          <div
            className={`h-full ${cluster.isVendorScale ? 'bg-slate-600' : 'bg-indigo-500'}`}
            style={{ width: `${Math.round(cluster.strength * 100)}%` }}
          />
        </div>
      </div>

      {cluster.isVendorScale && (
        <p className="px-3 pb-2 text-[10px] leading-relaxed text-amber-500/80">
          Shared with {others} committees. At this scale this is almost certainly a compliance firm
          or a shared office rather than a connection between them.
        </p>
      )}

      {open && (
        <>
          {undrawn.length > 0 && (
            <div className="px-3 pb-1.5">
              <button
                type="button"
                onClick={() => onAddToCanvas(cluster.peers.map((p) => p.id))}
                className="w-full rounded border border-indigo-800 bg-indigo-950/40 px-2 py-1
                           text-[11px] text-indigo-300 hover:bg-indigo-900/40"
              >
                Add {undrawn.length} to canvas
              </button>
              {/* Said once per cluster, because tiles that appear together read
                  as connected and these are not. Only money draws an edge. */}
              <p className="mt-1 text-[9px] leading-relaxed text-slate-600">
                Drawn as separate tiles. Any line between them is a payment the crawl already
                found, never the shared {cluster.basis}.
              </p>
            </div>
          )}
          <ul className="divide-y divide-slate-800/60">
            {cluster.peers.map((p) => (
              <li key={p.id} className="hover:bg-slate-800/50">
                <button
                  type="button"
                  onClick={() => onFocus(p.id)}
                  className="flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs text-slate-300">{p.name}</span>
                      {nodes.has(p.id) && (
                        <span className="shrink-0 text-[9px] text-indigo-400" title="On the canvas">
                          ●
                        </span>
                      )}
                    </span>
                    <span className="block text-[10px] text-slate-600">
                      {p.committeeType ?? p.kind}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-[11px] tabular-nums text-emerald-400/80">
                      {formatMoney(p.totalReceived)}
                    </span>
                    <span className="block text-[10px] tabular-nums text-amber-400/60">
                      {formatMoney(p.totalGiven)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {cluster.omitted > 0 && (
            <p className="px-3 py-1.5 text-[10px] text-slate-600">
              …and {cluster.omitted} more not listed.
            </p>
          )}
        </>
      )}
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
  'kind',
  'hops_away',
  'amount',
  'share',
  'share_of',
  'counts_toward_total',
  'entity_id',
  'notes',
];

const OPERATORS_HEADER = [
  'section',
  'basis',
  'name',
  'kind',
  'shared_value',
  'committees_sharing',
  'service_scale',
  'total_received',
  'total_given',
  'notes',
];

/**
 * Flatten the registration and its shared attributes into rows.
 *
 * `committees_sharing` is on every shared row for the same reason the panel
 * leads with it: a treasurer held in common with two other committees and one
 * held in common with 277 are the same fact in a spreadsheet and completely
 * different findings. `service_scale` marks the ones large enough that the
 * shared name is almost certainly a vendor.
 */
function operatorsCsvRows(r: AffiliationResult): (string | number)[][] {
  const rows: (string | number)[][] = [];
  const reg = r.registration;

  rows.push([
    'registration',
    '',
    r.entity.name,
    '',
    [...(reg?.addressLines ?? []), reg?.cityStateZip].filter(Boolean).join(', '),
    '',
    '',
    '',
    '',
    [
      reg?.externalId ? `account ${reg.externalId}` : null,
      reg?.phone,
      reg?.email,
      reg?.website,
      reg?.countyName ? `${reg.countyName} County` : null,
      reg?.typeDescription,
      reg?.observedAt ? `observed ${reg.observedAt}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  ]);

  for (const o of r.officers) {
    rows.push(['officer', o.role, o.fullName, 'person', '', '', '', '', '', 'As named on the filing.']);
  }

  for (const c of r.clusters) {
    for (const p of c.peers) {
      rows.push([
        'shared',
        c.basis,
        p.name,
        p.committeeType ?? p.kind,
        c.label,
        c.total,
        c.isVendorScale ? 'yes' : 'no',
        p.totalReceived,
        p.totalGiven,
        c.isVendorScale
          ? `Shared with ${c.total - 1} others — at this scale a shared name is a service provider, not a connection.`
          : 'Shared registration detail, not a payment. No money is implied between these committees.',
      ]);
    }
    if (c.omitted > 0) {
      rows.push([
        'shared',
        c.basis,
        '',
        '',
        c.label,
        c.total,
        c.isVendorScale ? 'yes' : 'no',
        '',
        '',
        `${c.omitted} further committees share this and are not listed.`,
      ]);
    }
  }

  return rows;
}

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
    rows.push(['traced', s.name, s.kind, s.hop, money(s.amount), share(s.share), seed, 'yes', s.id, '']);
  }

  for (const p of r.injectionPoints) {
    rows.push([
      'national_pool',
      p.name,
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
  onFocus: (nodeId: string) => void;
  nodes: Map<string, GraphNode>;
}) {
  if (state.error) return <p className="p-3 text-xs text-red-400">{state.error}</p>;
  if (state.loading && !state.result) {
    return <p className="p-3 text-xs text-slate-500">Following the money…</p>;
  }
  if (!state.result) return null;

  const r = state.result;
  const attributed = r.sources.reduce((a, b) => a + b.amount, 0);
  const viaPools = r.injectionPoints.reduce((a, b) => a + b.amount, 0);
  const unresolved = r.unresolved.reduce((a, b) => a + b.amount, 0);
  const pct = (n: number) => (r.seed.total > 0 ? (n / r.seed.total) * 100 : 0);

  const bar = (label: string, value: number, className: string) => (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[10px] text-slate-500">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-800">
        <div className={`h-full ${className}`} style={{ width: `${pct(value)}%` }} />
      </div>
      <span className="w-24 shrink-0 text-right text-[10px] tabular-nums text-slate-400">
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
        <label className="flex cursor-pointer items-center gap-2 text-[10px] text-slate-400">
          <input
            type="checkbox"
            checked={dateOrdered}
            onChange={onToggleDateOrdered}
            className="accent-indigo-500"
          />
          Only credit money a conduit held before it paid out
        </label>
        <p className="text-[10px] leading-relaxed text-slate-600">
          Pro-rata across {r.hops} hops: what share of the pool each source funded, not the route a
          particular dollar took.
          {r.truncated && ' Hit the strand ceiling — some paths folded into the long tail.'}
        </p>
      </div>

      {r.sources.length === 0 && (
        <p className="p-3 text-xs text-slate-600">
          No originating sources found. Every path ends at a committee with no recorded upstream.
        </p>
      )}

      <ul className="divide-y divide-slate-800/60">
        {r.sources.map((s) => (
          <li key={s.id} className="hover:bg-slate-800/50">
            <button
              type="button"
              onClick={() => onFocus(s.id)}
              className="flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs text-slate-200">{s.name}</span>
                  {nodes.has(s.id) && (
                    <span className="shrink-0 text-[9px] text-indigo-400" title="On the canvas">
                      ●
                    </span>
                  )}
                </span>
                <span className="block truncate text-[10px] text-slate-500">
                  {s.kind} · {s.hop} hop{s.hop === 1 ? '' : 's'} away
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-xs font-medium tabular-nums text-emerald-400">
                  {formatMoney(String(s.amount))}
                </span>
                <span className="block text-[10px] tabular-nums text-slate-500">
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
            <p className="text-[10px] uppercase tracking-wide text-sky-400">
              Entered Florida through a national pool
            </p>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <button
                type="button"
                onClick={() => onFocus(p.id)}
                className="min-w-0 flex-1 truncate text-left text-xs text-slate-200 hover:underline"
              >
                {p.name}
              </button>
              <span className="shrink-0 text-xs font-medium tabular-nums text-sky-300">
                {formatMoney(String(p.amount))} · {(p.share * 100).toFixed(1)}%
              </span>
            </div>
            {/* Shares are of the pool, never of the seed: how much of this
                pool reached Florida is not disclosed anywhere. */}
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
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
                  onClick={() => onFocus(f.id)}
                  className="flex w-full items-baseline justify-between gap-2 px-3 py-1 text-left"
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">
                    {f.name}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                    {formatMoney(String(f.amount))}
                  </span>
                  <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-slate-500">
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
          <p className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-slate-500">
            Trail ends here
          </p>
          <ul className="divide-y divide-slate-800/60">
            {r.unresolved.map((s) => (
              <li key={s.id} className="hover:bg-slate-800/50">
                <button
                  type="button"
                  onClick={() => onFocus(s.id)}
                  className="flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-slate-300">{s.name}</span>
                    <span className="block truncate text-[10px] text-slate-600">
                      no recorded upstream in this data
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-xs font-medium tabular-nums text-slate-400">
                      {formatMoney(String(s.amount))}
                    </span>
                    <span className="block text-[10px] tabular-nums text-slate-600">
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
