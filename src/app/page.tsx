'use client';

/**
 * PAC Tracker — main graph explorer.
 *
 * Pick a seed entity, choose how far and in which direction to crawl, and watch
 * the network build in progressively as levels stream back from the server.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import EntitySearch from '@/components/EntitySearch';
import ControlPanel from '@/components/ControlPanel';
import NodeDetail from '@/components/NodeDetail';
import SavedSearches from '@/components/SavedSearches';
import { useCrawl } from '@/lib/graph/useCrawl';
import {
  DEFAULT_SETTINGS,
  formatMoney,
  isOfficerNode,
  type CrawlSettings,
  type EntitySearchHit,
  type GraphNode,
  type ViewIntent,
} from '@/lib/graph/types';
import { ZOOM_STEP, PAN_STEP, type GraphCanvasHandle } from '@/components/GraphCanvas';

// Cytoscape touches `window` at import time, so it must not be server-rendered.
const GraphCanvas = dynamic(() => import('@/components/GraphCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-slate-500">
      Loading canvas…
    </div>
  ),
});

/**
 * Trade the browser's chrome for canvas.
 *
 * A phone gives the graph maybe 600px of height once the URL bar and the
 * switcher have taken their cut; fullscreen gives most of it back. Renders
 * nothing where the API is unavailable (notably iOS Safari), rather than
 * offering a button that does nothing.
 */
function FullScreenButton() {
  // Subscribed rather than mirrored into state: fullscreen is owned by the
  // browser and can be left with the back gesture or Escape, without us
  // hearing about it through a click handler.
  const on = useSyncExternalStore(
    (cb) => {
      document.addEventListener('fullscreenchange', cb);
      return () => document.removeEventListener('fullscreenchange', cb);
    },
    () => document.fullscreenElement !== null,
    () => false,
  );
  const supported = useSyncExternalStore(
    () => () => {},
    () => document.fullscreenEnabled,
    () => false,
  );

  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={() => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => {});
      }}
      title={on ? 'Leave full screen' : 'Full screen'}
      aria-label={on ? 'Leave full screen' : 'Full screen'}
      className="flex h-8 w-8 items-center justify-center rounded border border-slate-700
                 text-slate-300 hover:bg-slate-800 lg:hidden"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {on ? (
          <>
            <polyline points="9 4 9 9 4 9" />
            <polyline points="15 4 15 9 20 9" />
            <polyline points="9 20 9 15 4 15" />
            <polyline points="15 20 15 15 20 15" />
          </>
        ) : (
          <>
            <polyline points="4 9 4 4 9 4" />
            <polyline points="20 9 20 4 15 4" />
            <polyline points="4 15 4 20 9 20" />
            <polyline points="20 15 20 20 15 20" />
          </>
        )}
      </svg>
    </button>
  );
}

/** The three panes the phone layout swaps between. */
type MobilePane = 'graph' | 'detail' | 'filters';

export default function Home() {
  const [seed, setSeed] = useState<EntitySearchHit | null>(null);
  const [settings, setSettings] = useState<CrawlSettings>(DEFAULT_SETTINGS);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [restoredPositions, setRestoredPositions] =
    useState<Record<string, { x: number; y: number }> | null>(null);
  const [tab, setTab] = useState<'controls' | 'saved'>('controls');
  // Which pane the phone layout is showing. Ignored from `lg` up, where all
  // three are on screen at once, so it can be set unconditionally.
  const [pane, setPane] = useState<MobilePane>('graph');

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

    // `?person=Ingoglia,Blaise` is the entry point for links arriving from
    // another application, which knows a politician's name but not the id of
    // any of their committees. Seeds on their largest filing — usually the
    // affiliated committee rather than the campaign account.
    if (!seedId && q.has('person')) {
      const [last = '', first = ''] = (q.get('person') ?? '').split(',').map((v) => v.trim());
      if (last && first) {
        void (async () => {
          const res = await fetch(
            `/api/people/${encodeURIComponent(last)}/${encodeURIComponent(first)}?top=0`,
          );
          if (!res.ok) return;
          const { person } = await res.json();
          const biggest = person?.parts?.[0]?.id;
          if (!biggest) return;
          const e = await fetch(`/api/entities/${biggest}`);
          if (e.ok) setSeed((await e.json()).entity);
        })();
      }
      return;
    }

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
   * Tapping a node on a phone should show what you tapped. Harmless on
   * desktop, where every pane is visible and `pane` goes unread.
   */
  const handleSelectNode = useCallback((node: GraphNode | null) => {
    setSelected(node);
    if (node) setPane('detail');
  }, []);

  // Cytoscape measures its container once and caches it, so the canvas comes
  // back from `display: none` believing it is 0x0. Remeasure after the browser
  // has laid the pane back out, not in the same frame that unhides it.
  useEffect(() => {
    if (pane !== 'graph') return;
    const id = requestAnimationFrame(() => canvasRef.current?.resize());
    return () => cancelAnimationFrame(id);
  }, [pane]);

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

  /**
   * Arrow keys pan the canvas; +/− and = zoom.
   *
   * Bound to the window rather than the canvas because the canvas is rarely
   * what holds focus — the user has usually just clicked a tile or a panel row.
   * That makes it the caller's job to stay out of the way of typing, so the
   * handler bails whenever focus is in a field or a modifier is held, and
   * `preventDefault` runs only on keys actually consumed. Without the first
   * check, arrowing through the search box would drag the graph instead of
   * moving the caret.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable ||
          t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT')
      ) {
        return;
      }
      const cv = canvasRef.current;
      if (!cv) return;

      switch (e.key) {
        case 'ArrowLeft':
          cv.panBy(-PAN_STEP, 0);
          break;
        case 'ArrowRight':
          cv.panBy(PAN_STEP, 0);
          break;
        case 'ArrowUp':
          cv.panBy(0, -PAN_STEP);
          break;
        case 'ArrowDown':
          cv.panBy(0, PAN_STEP);
          break;
        case '+':
        case '=':
          cv.zoomBy(ZOOM_STEP);
          break;
        case '-':
        case '_':
          cv.zoomBy(1 / ZOOM_STEP);
          break;
        default:
          return;
      }
      e.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
      // Officer hubs exist only on the canvas; there is nothing to fetch and
      // the id is not a uuid, so the lookup would 400.
      if (isOfficerNode(entityId)) return;
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
    <div className="flex h-dvh flex-col bg-slate-950 text-slate-100">
      {/* ------------------------------------------------------------ header */}
      <header className="flex shrink-0 items-center gap-4 border-b border-slate-800 px-4 py-3">
        <div className="flex shrink-0 items-baseline gap-2">
          <h1 className="text-sm font-semibold tracking-tight lg:text-base">PAC Tracker</h1>
          <span className="hidden text-xs text-slate-500 lg:inline">Florida</span>
        </div>

        <div className="max-w-xl flex-1">
          <EntitySearch onSelect={handleSearchSelect} cycle={settings.cycle} />
        </div>

        <div className="flex shrink-0 items-center gap-3 text-xs text-slate-400">
          {crawl.loading && (
            <span className="hidden items-center gap-1.5 text-indigo-400 lg:flex">
              <span
                className="h-3 w-3 animate-spin rounded-full border-2 border-indigo-900
                           border-t-indigo-400"
              />
              level {crawl.levelsDone}…
            </span>
          )}
          {crawl.nodes.size > 0 && (
            <span className="hidden tabular-nums lg:inline">
              {crawl.nodes.size} nodes · {crawl.edges.size} edges ·{' '}
              <span className="text-emerald-400">{formatMoney(totalTracked)}</span>
              {crawl.elapsedMs != null && !crawl.loading && (
                <span className="text-slate-600"> · {crawl.elapsedMs}ms</span>
              )}
            </span>
          )}
          {crawl.truncated && (
            <span className="hidden rounded bg-amber-950 px-2 py-0.5 text-amber-400 lg:inline">
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
          <FullScreenButton />
          <button
            type="button"
            onClick={() =>
              canvasRef.current?.exportPng(
                `pactracker-${(seed?.name ?? 'graph').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
              )
            }
            disabled={crawl.nodes.size === 0}
            className="hidden rounded border border-slate-700 px-2 py-1 hover:bg-slate-800
                       disabled:opacity-40 lg:block"
          >
            Save PNG
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* --------------------------------------------------------- sidebar */}
        <aside
          className={`w-full shrink-0 flex-col border-slate-800 lg:flex lg:w-72 lg:border-r
            ${pane === 'filters' ? 'flex' : 'hidden'}`}
        >
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
        <main className={`relative min-w-0 flex-1 lg:block ${pane === 'graph' ? 'block' : 'hidden'}`}>
          {!seed ? (
            <EmptyState />
          ) : (
            <GraphCanvas
              nodes={crawl.nodes}
              edges={crawl.edges}
              seedId={seed.id}
              initialPositions={restoredPositions}
              onSelectNode={handleSelectNode}
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

          {seed && <ViewControls canvasRef={canvasRef} />}
          {seed && <Legend />}
        </main>

        {/* --------------------------------------------------------- detail */}
        <aside
          className={`w-full shrink-0 flex-col overflow-hidden border-slate-800 lg:flex lg:w-80
            lg:border-l ${pane === 'detail' ? 'flex' : 'hidden'}`}
        >
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

      <MobileTabs pane={pane} onChange={setPane} hasSelection={selectedNode !== null} />
    </div>
  );
}

/**
 * Zoom and pan without a wheel or a trackpad.
 *
 * Bottom-left, clear of the legend. Arrow keys do the same panning, so both are
 * documented here rather than leaving the keyboard route undiscoverable.
 */
function ViewControls({
  canvasRef,
}: {
  canvasRef: React.RefObject<GraphCanvasHandle | null>;
}) {
  const btn =
    'flex h-7 w-7 items-center justify-center rounded border border-slate-700 bg-slate-900/90 ' +
    'text-slate-300 hover:bg-slate-800 hover:text-slate-100';

  return (
    <div className="absolute bottom-20 left-4 flex flex-col items-start gap-1 lg:bottom-4">
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => canvasRef.current?.zoomBy(ZOOM_STEP)}
          className={btn}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => canvasRef.current?.zoomBy(1 / ZOOM_STEP)}
          className={btn}
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
      </div>
      <p className="hidden text-[10px] text-slate-600 lg:block">Arrow keys pan</p>
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

/**
 * Pane switcher for phone widths.
 *
 * The desktop layout puts controls, canvas and inspector side by side; below
 * `lg` there is room for exactly one, so they become tabs. Hidden from `lg` up,
 * where all three are on screen and `pane` is not read.
 */
function MobileTabs({
  pane,
  onChange,
  hasSelection,
}: {
  pane: MobilePane;
  onChange: (p: MobilePane) => void;
  hasSelection: boolean;
}) {
  const tabs: { value: MobilePane; label: string; icon: React.ReactNode }[] = [
    {
      value: 'graph',
      label: 'Graph',
      icon: (
        <>
          <circle cx="6" cy="7" r="2.5" />
          <circle cx="18" cy="6" r="2.5" />
          <circle cx="12" cy="17" r="2.5" />
          <line x1="7.7" y1="8.6" x2="10.6" y2="15" />
          <line x1="16.6" y1="8" x2="13.4" y2="15.2" />
          <line x1="8.4" y1="6.6" x2="15.5" y2="6.2" />
        </>
      ),
    },
    {
      value: 'detail',
      label: 'Detail',
      icon: (
        <>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="14" y2="17" />
        </>
      ),
    },
    {
      value: 'filters',
      label: 'Filters',
      icon: (
        <>
          <line x1="4" y1="8" x2="20" y2="8" />
          <circle cx="15" cy="8" r="2.5" />
          <line x1="4" y1="16" x2="20" y2="16" />
          <circle cx="9" cy="16" r="2.5" />
        </>
      ),
    },
  ];

  return (
    <nav
      className="grid shrink-0 grid-cols-3 border-t border-slate-800 bg-slate-950 lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {tabs.map((t) => {
        const on = pane === t.value;
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => onChange(t.value)}
            aria-current={on ? 'page' : undefined}
            className={`flex h-14 flex-col items-center justify-center gap-1 transition
              ${on ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}
          >
            <span className="relative">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              >
                {t.icon}
              </svg>
              {/* A node is selected but its pane is not showing — say so, so the
                  tap that opened it does not look like it did nothing. */}
              {t.value === 'detail' && hasSelection && !on && (
                <span className="absolute -right-1 -top-0.5 h-1.5 w-1.5 rounded-full bg-indigo-400" />
              )}
            </span>
            <span className="text-[10px] font-medium">{t.label}</span>
          </button>
        );
      })}
    </nav>
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
      className="pointer-events-none absolute bottom-4 right-4 hidden space-y-1 rounded
                 border border-slate-800 bg-slate-900/80 px-3 py-2 backdrop-blur lg:block"
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
