'use client';

/** Inspector for the selected tile, plus its largest inbound/outbound edges. */

import { useMemo } from 'react';
import {
  formatMoneyFull,
  formatMoney,
  kindLabel,
  type GraphEdge,
  type GraphNode,
} from '@/lib/graph/types';

/**
 * Ranked list of an entity's counterparties in one direction.
 *
 * Declared at module scope, not inside NodeDetail: a component defined during
 * render gets a new identity every pass, so React remounts the whole subtree
 * and the list loses scroll position on every selection change.
 */
function EdgeList({
  list,
  dir,
  nodes,
  onFocus,
}: {
  list: GraphEdge[];
  dir: 'in' | 'out';
  nodes: Map<string, GraphNode>;
  onFocus: (nodeId: string) => void;
}) {
  return (
    <ul className="space-y-1">
      {list.length === 0 && (
        <li className="text-xs text-slate-500">
          None in the current view — increase depth or lower the minimum.
        </li>
      )}
      {list.map((e) => {
        const otherId = dir === 'in' ? e.source : e.target;
        const other = nodes.get(otherId);
        return (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => onFocus(otherId)}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1
                         text-left hover:bg-slate-800"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-slate-300">
                {other?.name ?? 'unknown'}
              </span>
              <span
                className={`shrink-0 text-xs font-medium tabular-nums
                  ${dir === 'in' ? 'text-emerald-400' : 'text-amber-400'}`}
              >
                {formatMoney(e.amount)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

interface Props {
  node: GraphNode | null;
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  onFocus: (nodeId: string) => void;
  onRecenter: (nodeId: string) => void;
}

export default function NodeDetail({ node, nodes, edges, onFocus, onRecenter }: Props) {
  const { inbound, outbound } = useMemo(() => {
    if (!node) return { inbound: [], outbound: [] };
    const inb: GraphEdge[] = [];
    const out: GraphEdge[] = [];
    for (const e of edges.values()) {
      if (e.target === node.id) inb.push(e);
      else if (e.source === node.id) out.push(e);
    }
    const byAmount = (a: GraphEdge, b: GraphEdge) => Number(b.amount) - Number(a.amount);
    return { inbound: inb.sort(byAmount).slice(0, 12), outbound: out.sort(byAmount).slice(0, 12) };
  }, [node, edges]);

  if (!node) {
    return (
      <div className="p-4 text-sm text-slate-500">
        Select a tile to inspect it. Double-click a tile to re-center the crawl there.
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div>
        <h3 className="text-sm font-semibold leading-snug text-slate-100">{node.name}</h3>
        <p className="mt-0.5 text-xs text-slate-400">
          {kindLabel(node)}
          {node.status === 'closed' && ' · closed'}
          {node.city && ` · ${node.city}, ${node.stateCode ?? ''}`}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded border border-slate-800 bg-slate-900/60 p-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Received</div>
          <div className="text-sm font-semibold text-emerald-400">
            {formatMoneyFull(node.totalReceived)}
          </div>
          <div className="text-[10px] text-slate-500">{node.inDegree} sources</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/60 p-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Given</div>
          <div className="text-sm font-semibold text-amber-400">
            {formatMoneyFull(node.totalGiven)}
          </div>
          <div className="text-[10px] text-slate-500">{node.outDegree} recipients</div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => onRecenter(node.id)}
        className="w-full rounded bg-indigo-600 px-3 py-2 text-xs font-medium text-white
                   hover:bg-indigo-500"
      >
        Re-center crawl here
      </button>

      <div>
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
          Top money in ({inbound.length})
        </h4>
        <EdgeList list={inbound} dir="in" nodes={nodes} onFocus={onFocus} />
      </div>

      <div>
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
          Top money out ({outbound.length})
        </h4>
        <EdgeList list={outbound} dir="out" nodes={nodes} onFocus={onFocus} />
      </div>
    </div>
  );
}
