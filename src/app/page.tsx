'use client';

/**
 * PAC Tracker — main graph explorer.
 *
 * Pick a seed entity, choose how far and in which direction to crawl, and watch
 * the network build in progressively as levels stream back from the server.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import EntitySearch from '@/components/EntitySearch';
import ControlPanel from '@/components/ControlPanel';
import NodeDetail from '@/components/NodeDetail';
import SavedSearches from '@/components/SavedSearches';
import { useCrawl } from '@/lib/graph/useCrawl';
import {
  DEFAULT_SETTINGS,
  formatMoney,
  type CrawlSettings,
  type EntitySearchHit,
  type GraphNode,
  type ViewIntent,
} from '@/lib/graph/types';
import type { GraphCanvasHandle } from '@/components/GraphCanvas';

// Cytoscape touches `window` at import time, so it must not be server-rendered.
const GraphCanvas = dynamic(() => import('@/components/GraphCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-slate-500">
      Loading canvas…
    </div>
  ),
});

export default function Home() {
  const [seed, setSeed] = useState<EntitySearchHit | null>(null);
  const [settings, setSettings] = useState<CrawlSettings>(DEFAULT_SETTINGS);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [restoredPositions, setRestoredPositions] =
    useState<Record<string, { x: number; y: number }> | null>(null);
  const [tab, setTab] = useState<'controls' | 'saved'>('controls');

  const crawl = useCrawl();
  const canvasRef = useRef<GraphCanvasHandle | null>(null);
  const startCrawl = crawl.start;

  /**
   * Restore a shared link on first load: ?seed=<uuid>&depth=3&linkMode=donor…
   *
   * Reading `window.location` is exactly the "subscribe to an external system"
   * case effects exist for; the URL is not available during render.
   */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const seedId = q.get('seed');
    if (!seedId) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrating from the URL
    setSettings((prev) => ({
      ...prev,
      depth: q.has('depth') ? Number(q.get('depth')) : prev.depth,
      direction: (q.get('direction') as CrawlSettings['direction']) ?? prev.direction,
      linkMode: (q.get('linkMode') as CrawlSettings['linkMode']) ?? prev.linkMode,
      minAmount: q.has('minAmount') ? Number(q.get('minAmount')) : prev.minAmount,
      // An explicit `cycle=` of empty string means "all cycles", which is
      // different from the parameter being absent.
      cycle: q.has('cycle') ? q.get('cycle') || undefined : prev.cycle,
    }));

    // The link carries only an id, so fetch the entity to label the header.
    void (async () => {
      const res = await fetch(`/api/entities/${seedId}`);
      if (res.ok) setSeed((await res.json()).entity);
    })();
  }, []);

  /**
   * Drive the crawl whenever the seed or any setting changes.
   *
   * The crawl is an external system (an SSE stream), so starting it from an
   * effect is correct. Clearing the selection is part of tearing down the old
   * stream's results — the previously selected node may not exist in the new
   * graph at all.
   */
  useEffect(() => {
    if (!seed) return;
    // Drop a selection that belonged to the superseded graph, but keep it when
    // the user selected this very entity — picking someone from search sets the
    // seed *and* selects them, and clearing here would blank the panel again.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- discarding results of the superseded stream
    setSelected((prev) => (prev?.id === seed.id ? prev : null));
    startCrawl(seed.id, settings);

    // Keep the address bar in sync so the current view is always shareable.
    const q = new URLSearchParams({
      seed: seed.id,
      depth: String(settings.depth),
      direction: settings.direction,
      linkMode: settings.linkMode,
    });
    if (settings.minAmount != null) q.set('minAmount', String(settings.minAmount));
    q.set('cycle', settings.cycle ?? '');
    window.history.replaceState(null, '', `?${q}`);
  }, [seed, settings, startCrawl]);

  /**
   * Prefer the crawl's copy of the selected node over the one that seeded it.
   *
   * Picking a result from search fills the panel straight from the search hit,
   * whose totals span every cycle. The crawl returns the same node with totals
   * for the cycle actually being viewed, so once it arrives it wins — otherwise
   * a filtered graph sits next to unfiltered numbers.
   */
  const selectedNode = selected ? (crawl.nodes.get(selected.id) ?? selected) : null;

  /**
   * Tell the canvas what to do with the viewport once the stream closes.
   *
   * Handed over as a token rather than a direct call because the canvas is
   * lazily loaded and a crawl over warm data routinely finishes before it has
   * mounted. `pendingFocusId` records that the crawl was started by picking a
   * specific entity, so the canvas homes in on them instead of framing the
   * whole graph — otherwise the fit would immediately undo the zoom.
   */
  const [viewIntent, setViewIntent] = useState<ViewIntent>({ kind: 'fit', token: 0 });
  const pendingFocusId = useRef<string | null>(null);

  const requestFocus = useCallback((nodeId: string) => {
    setViewIntent((v) => ({ kind: 'focus', nodeId, token: v.token + 1 }));
  }, []);

  const crawlDone = !crawl.loading && crawl.nodes.size > 0;
  useEffect(() => {
    if (!crawlDone) return;
    const focusId = pendingFocusId.current;
    pendingFocusId.current = null;
    setViewIntent((v) =>
      focusId
        ? { kind: 'focus', nodeId: focusId, token: v.token + 1 }
        : { kind: 'fit', token: v.token + 1 },
    );
  }, [crawlDone, crawl.nodes.size]);

  /**
   * Picking an entity from search: make it the crawl's seed, select it so the
   * detail panel fills in immediately, and zoom to it once the graph settles.
   */
  const handleSearchSelect = useCallback((hit: EntitySearchHit) => {
    setRestoredPositions(null);
    pendingFocusId.current = hit.id;
    setSeed(hit);
    setSelected({
      id: hit.id,
      name: hit.name,
      kind: hit.kind,
      committeeType: hit.committee_type,
      status: hit.status,
      office: null,
      party: null,
      city: hit.city,
      stateCode: hit.state_code,
      totalReceived: hit.total_received,
      totalGiven: hit.total_given,
      inDegree: hit.in_degree,
      outDegree: hit.out_degree,
      isTraversable: hit.is_traversable,
      level: 0,
    });
  }, []);

  /**
   * Select a counterparty from the ledger.
   *
   * The ledger lists everything in the database, most of which is not on the
   * canvas, so a row that has no corresponding node is fetched on demand rather
   * than silently clearing the panel.
   */
  const handleFocusEntity = useCallback(
    async (entityId: string) => {
      const inGraph = crawl.nodes.get(entityId);
      if (inGraph) {
        setSelected(inGraph);
        requestFocus(entityId);
        return;
      }
      const res = await fetch(`/api/entities/${entityId}`);
      if (!res.ok) return;
      const e = (await res.json()).entity;
      setSelected({
        id: e.id,
        name: e.name,
        kind: e.kind,
        committeeType: e.committee_type,
        status: e.status,
        office: e.office ?? null,
        party: e.party ?? null,
        city: e.city,
        stateCode: e.state_code,
        totalReceived: e.total_received,
        totalGiven: e.total_given,
        inDegree: e.in_degree,
        outDegree: e.out_degree,
        isTraversable: e.is_traversable,
        level: -1, // not part of the current crawl
      });
    },
    [crawl.nodes, requestFocus],
  );

  /**
   * Re-root the crawl. Accepts any entity, including one reached through the
   * ledger that was never drawn, so "re-center here" always works.
   */
  const handleRecenter = useCallback(
    (nodeId: string) => {
      const node = crawl.nodes.get(nodeId) ?? (selected?.id === nodeId ? selected : null);
      if (!node) return;
      setRestoredPositions(null);
      setSeed({
        id: node.id,
        name: node.name,
        kind: node.kind,
        committee_type: node.committeeType,
        status: node.status,
        city: node.city,
        state_code: node.stateCode,
        total_received: node.totalReceived,
        total_given: node.totalGiven,
        in_degree: node.inDegree,
        out_degree: node.outDegree,
        is_traversable: node.isTraversable,
        score: 1,
      });
    },
    [crawl.nodes, selected],
  );

  let totalTracked = 0;
  for (const e of crawl.edges.values()) totalTracked += Number(e.amount);

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      {/* ------------------------------------------------------------ header */}
      <header className="flex shrink-0 items-center gap-4 border-b border-slate-800 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-base font-semibold tracking-tight">PAC Tracker</h1>
          <span className="text-xs text-slate-500">Florida</span>
        </div>

        <div className="max-w-xl flex-1">
          <EntitySearch onSelect={handleSearchSelect} cycle={settings.cycle} />
        </div>

        <div className="flex items-center gap-3 text-xs text-slate-400">
          {crawl.loading && (
            <span className="flex items-center gap-1.5 text-indigo-400">
              <span
                className="h-3 w-3 animate-spin rounded-full border-2 border-indigo-900
                           border-t-indigo-400"
              />
              level {crawl.levelsDone}…
            </span>
          )}
          {crawl.nodes.size > 0 && (
            <span className="tabular-nums">
              {crawl.nodes.size} nodes · {crawl.edges.size} edges ·{' '}
              <span className="text-emerald-400">{formatMoney(totalTracked)}</span>
              {crawl.elapsedMs != null && !crawl.loading && (
                <span className="text-slate-600"> · {crawl.elapsedMs}ms</span>
              )}
            </span>
          )}
          {crawl.truncated && (
            <span className="rounded bg-amber-950 px-2 py-0.5 text-amber-400">
              capped at {settings.maxNodes} nodes
            </span>
          )}
          <button
            type="button"
            onClick={() => canvasRef.current?.fit()}
            disabled={crawl.nodes.size === 0}
            className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800
                       disabled:opacity-40"
          >
            Fit
          </button>
          <button
            type="button"
            onClick={() =>
              canvasRef.current?.exportPng(
                `pactracker-${(seed?.name ?? 'graph').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
              )
            }
            disabled={crawl.nodes.size === 0}
            className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800
                       disabled:opacity-40"
          >
            Save PNG
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* --------------------------------------------------------- sidebar */}
        <aside className="flex w-72 shrink-0 flex-col border-r border-slate-800">
          <div className="flex shrink-0 border-b border-slate-800">
            {(['controls', 'saved'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`flex-1 px-3 py-2 text-xs font-medium transition
                  ${
                    tab === t
                      ? 'border-b-2 border-indigo-500 text-slate-100'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
              >
                {t === 'saved' ? 'Saved searches' : 'Controls'}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === 'controls' ? (
              <ControlPanel settings={settings} onChange={setSettings} />
            ) : (
              <SavedSearches
                currentSeedId={seed?.id ?? null}
                currentSeedName={seed?.name ?? null}
                settings={settings}
                getPositions={() => canvasRef.current?.getPositions() ?? {}}
                onLoad={(s) => {
                  setSettings({ ...DEFAULT_SETTINGS, ...(s.params as Partial<CrawlSettings>) });
                  setRestoredPositions(
                    (s.nodePositions as Record<string, { x: number; y: number }> | null) ?? null,
                  );
                  setSeed({
                    id: s.seedEntityId,
                    name: s.seedName ?? 'seed',
                    kind: s.seedKind ?? 'unknown',
                    committee_type: null,
                    status: 'unknown',
                    city: null,
                    state_code: null,
                    total_received: '0',
                    total_given: '0',
                    in_degree: 0,
                    out_degree: 0,
                    is_traversable: true,
                    score: 1,
                  });
                }}
              />
            )}
          </div>
        </aside>

        {/* ---------------------------------------------------------- canvas */}
        <main className="relative min-w-0 flex-1">
          {!seed ? (
            <EmptyState />
          ) : (
            <GraphCanvas
              nodes={crawl.nodes}
              edges={crawl.edges}
              seedId={seed.id}
              initialPositions={restoredPositions}
              onSelectNode={setSelected}
              onExpandNode={handleRecenter}
              viewIntent={viewIntent}
              selectedId={selectedNode?.id ?? null}
              onReady={(h) => {
                canvasRef.current = h;
              }}
            />
          )}

          {crawl.error && (
            <div
              className="absolute bottom-4 left-4 rounded border border-red-800 bg-red-950/90
                         px-3 py-2 text-xs text-red-300"
            >
              {crawl.error}
            </div>
          )}

          {seed && <Legend />}
        </main>

        {/* --------------------------------------------------------- detail */}
        <aside className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-slate-800">
          {/* Keyed on the entity so the ledger's paging, filter and scroll
              state reset cleanly when the selection changes. */}
          <NodeDetail
            key={selectedNode?.id ?? 'none'}
            node={selectedNode}
            nodes={crawl.nodes}
            onFocus={handleFocusEntity}
            onRecenter={handleRecenter}
            cycle={settings.cycle}
          />
        </aside>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <h2 className="text-lg font-medium text-slate-300">Follow the money</h2>
      <p className="max-w-md text-sm leading-relaxed text-slate-500">
        Search for a Florida committee, candidate or donor above to seed the graph. The crawler
        walks the money in and out from there, one level at a time, drawing tiles as they arrive.
      </p>
      <p className="max-w-md text-xs text-slate-600">
        Try &ldquo;Florida Chamber&rdquo;, &ldquo;Keep Florida Clean&rdquo; or &ldquo;Secure
        Florida&rsquo;s Future&rdquo;.
      </p>
    </div>
  );
}

function Legend() {
  const items = [
    ['#6366f1', 'Committee / PAC'],
    ['#10b981', 'Candidate'],
    ['#f59e0b', 'Organization'],
    ['#64748b', 'Individual'],
  ] as const;
  return (
    <div
      className="pointer-events-none absolute bottom-4 right-4 space-y-1 rounded
                 border border-slate-800 bg-slate-900/80 px-3 py-2 backdrop-blur"
    >
      {items.map(([color, label]) => (
        <div key={label} className="flex items-center gap-2 text-[11px] text-slate-400">
          <span
            className="h-2.5 w-2.5 rounded-sm border"
            style={{ borderColor: color, backgroundColor: `${color}28` }}
          />
          {label}
        </div>
      ))}
    </div>
  );
}
