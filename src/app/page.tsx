'use client';

/**
 * PAC Tracker — main graph explorer.
 *
 * Pick a seed entity, choose how far and in which direction to crawl, and watch
 * the network build in progressively as levels stream back from the server.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import dynamic from 'next/dynamic';
import EntitySearch from '@/components/EntitySearch';
import ControlPanel from '@/components/ControlPanel';
import NodeDetail from '@/components/NodeDetail';
import SavedSearches from '@/components/SavedSearches';
import AccountButton from '@/components/AccountButton';
import { useCrawl } from '@/lib/graph/useCrawl';
import { useOfficers, useOfficerSubject, type EntityOfficer } from '@/lib/graph/useOfficers';
import type { LedgerDirection } from '@/lib/graph/useLedger';
import {
  DEFAULT_SETTINGS,
  formatMoney,
  formatMoneyFull,
  committeeCount,
  industryLabel,
  isOfficerNode,
  kindColor,
  kindLabel,
  withLinkMode,

  type CrawlSettings,

  type EntitySearchHit,
  type FocusLink,
  type GraphNode,
  type ViewIntent,
} from '@/lib/graph/types';
import {
  ZOOM_STEP,
  PAN_STEP,
  type GhostGraph,
  type GraphCanvasHandle,
} from '@/components/GraphCanvas';

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

/**
 * A person named on filings, as a selectable node.
 *
 * The crawl builds these itself in registration mode. This is the same shape
 * for the other modes, where the hub is not drawn but the panel can still
 * report what the person's committees hold — the real totals arrive from
 * `useOfficerSubject`, which is why the zeroes here are harmless.
 */
function officerHubNode(id: string, name: string, role: string): GraphNode {
  return {
    id,
    name,
    kind: 'officer',
    committeeType: null,
    status: 'active',
    office: role,
    party: null,
    city: null,
    stateCode: null,
    industry: null,
    totalReceived: '0',
    totalGiven: '0',
    inDegree: 0,
    outDegree: 0,
    isTraversable: false,
    level: -1,
  };
}


export default function Home() {
  const [seed, setSeed] = useState<EntitySearchHit | null>(null);
  /**
   * The money settings in force before "Find linked registrations" took over.
   *
   * That button swaps the graph onto shared officers and widens the per-node
   * cap to suit it, which is a large change to have made with one click.
   * Refreshing puts both back, so the detour is undoable without anyone having
   * to remember what it was set to.
   */
  const [beforeRegistrations, setBeforeRegistrations] = useState<{
    linkMode: CrawlSettings['linkMode'];
    maxPerNode: number;
  } | null>(null);
  const [settings, setSettings] = useState<CrawlSettings>(DEFAULT_SETTINGS);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [restoredPositions, setRestoredPositions] =
    useState<Record<string, { x: number; y: number }> | null>(null);
  const [tab, setTab] = useState<'controls' | 'saved'>('controls');
  /**
   * Which side of the ledger to read. Held here rather than in the panel
   * because the tiles that set it sit over the canvas now, and the rows they
   * filter sit in the panel.
   */
  const [direction, setDirection] = useState<LedgerDirection>('in');
  /**
   * How the current selection connects back to where the reader came from,
   * and any tiles the canvas has to borrow to draw it. See `handleFocusEntity`.
   */
  const [chain, setChain] = useState<string[] | null>(null);
  const [ghost, setGhost] = useState<GhostGraph | null>(null);
  /**
   * Every tile opened since the search, in the order they were opened.
   *
   * Click history, not a path through the graph: two entries in a row need not
   * be connected, because the reader can arrive anywhere from the ledger.
   * Excludes the entity being searched, which is the fixed point the trail
   * hangs off. Revisiting an entry truncates back to it, so the trail is
   * always a route the reader could retrace.
   */
  const [trail, setTrail] = useState<GraphNode[]>([]);

  // Which pane the phone layout is showing. Ignored from `lg` up, where all
  // three are on screen at once, so it can be set unconditionally.
  const [pane, setPane] = useState<MobilePane>('graph');

  const crawl = useCrawl();
  const canvasRef = useRef<GraphCanvasHandle | null>(null);
  /**
   * How the escape binding reaches the current reset.
   *
   * The key handler is installed once for the life of the page, so it cannot
   * close over a callback that is rebuilt whenever the graph changes.
   */
  const resetRef = useRef<() => void>(() => {});
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
    // The route, its borrowed tiles and the history of where the reader has
    // been all belong to the graph being torn down.
    setChain(null);
    setGhost(null);
    setTrail([]);

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
   * The person behind an officer hub, whose totals are the union of their
   * committees'. Null for everything else, and it makes no request for one.
   */
  const subject = useOfficerSubject(selectedNode?.id ?? null, settings.cycle);

  /**
   * Chair and treasurer, for two different subjects.
   *
   * The bar names the officers of the entity the crawl was started from and
   * keeps them there, so they are a fixed feature of the view rather than
   * something that changes under the cursor. The panel names the selection's,
   * which is what a phone shows instead of the bar. An officer hub is already
   * a person and has none of its own.
   */
  const officerHub = selectedNode !== null && isOfficerNode(selectedNode.id);
  const officers = useOfficers(officerHub ? null : (selectedNode?.id ?? null));
  const searchedOfficers = useOfficers(seed?.id ?? null);


  // A hub holds nothing itself, so its headline has to come from the person.
  const received = subject?.totalReceived ?? selectedNode?.totalReceived ?? '0';
  const given = subject?.totalGiven ?? selectedNode?.totalGiven ?? '0';

  /**
   * Record a tile as somewhere the reader has been.
   *
   * The entity being searched is never in the trail: it is what the trail
   * hangs off, and the bar names it separately. Going back to a tile already
   * in the trail cuts everything after it, rather than appending the same tile
   * twice — which is what makes the breadcrumb a route rather than a log.
   */
  const pushTrail = useCallback(
    (node: GraphNode | null) => {
      setTrail((prev) => {
        if (!node || node.id === seed?.id) return [];
        const seen = prev.findIndex((n) => n.id === node.id);
        return seen === -1 ? [...prev, node] : prev.slice(0, seen + 1);
      });
    },
    [seed?.id],
  );

  /**
   * Tapping a node on a phone should show what you tapped. Harmless on
   * desktop, where every pane is visible and `pane` goes unread.
   *
   * Drops the route: a tap on a tile asks who it trades with, not how it
   * connects to whatever was open before. Borrowed tiles stay, because one of
   * them may be the tile that was just tapped.
   */
  const handleSelectNode = useCallback(
    (node: GraphNode | null) => {
      setSelected(node);
      setChain(null);
      pushTrail(node);
      if (node) setPane('detail');
      else setGhost(null);
    },
    [pushTrail],
  );




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
        // Out of an exploration, not out of the app: the crawl and its
        // settings are left exactly as they were.
        case 'Escape':
          resetRef.current();
          break;
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
      industry: hit.industry,
      totalReceived: hit.total_received,
      totalGiven: hit.total_given,
      inDegree: hit.in_degree,
      outDegree: hit.out_degree,
      isTraversable: hit.is_traversable,
      level: 0,
    });
  }, []);

  /**
   * Fetch one entity as a graph node.
   *
   * Marked level -1: it is a real entity, but it is not part of the crawl the
   * canvas is drawing. Returns null for an officer hub, whose id is not a uuid
   * and exists only on the canvas, and for anything the lookup cannot find.
   */
  const fetchNode = useCallback(async (id: string): Promise<GraphNode | null> => {
    if (isOfficerNode(id)) return null;
    const res = await fetch(`/api/entities/${id}`);
    if (!res.ok) return null;
    const e = (await res.json()).entity;
    return {
      id: e.id,
      name: e.name,
      kind: e.kind,
      committeeType: e.committee_type,
      status: e.status,
      office: e.office ?? null,
      party: e.party ?? null,
      city: e.city,
      stateCode: e.state_code,
      industry: e.industry ?? null,
      totalReceived: e.total_received,
      totalGiven: e.total_given,
      inDegree: e.in_degree,
      outDegree: e.out_degree,
      isTraversable: e.is_traversable,
      level: -1,
    };
  }, []);

  /**
   * Open a name the panel offered, and show how it connects to what was open.
   *
   * The panel reads from the database; the canvas draws a capped, filtered
   * slice of it. So a name in the ledger routinely has no tile — in `direct`
   * mode an individual donor never does — and following it used to move the
   * whole panel with nothing happening on screen to say why. The route is
   * drawn instead: any tile it needs and the graph does not have is borrowed
   * for as long as that route is the selection, and everything else dims.
   *
   * The origins report supplies its own route, several transfers long. A
   * ledger row supplies none, because it is one hop off whatever is open, and
   * only this knows what that is.
   */
  const handleFocusEntity = useCallback(
    async (entityId: string, link?: FocusLink) => {
      const from = selected?.id ?? null;
      const supplied = link?.chain && link.chain.length > 1 ? link.chain : null;
      const route = (supplied ?? (from && from !== entityId ? [from, entityId] : [entityId]))
        // A route that doubles back would draw a hop from a tile to itself.
        .filter((id, i, all) => all.indexOf(id) === i);

      const missing = route.filter((id) => !crawl.nodes.has(id));
      const borrowed = new Map<string, GraphNode>();
      for (const n of await Promise.all(missing.map(fetchNode))) {
        if (n) borrowed.set(n.id, n);
      }

      // An officer hub is a person, not a row in `entities`, so there is
      // nothing to fetch. It exists as a tile only while the graph is
      // following registration links — but the panel can answer for a person
      // either way, so the click opens them rather than doing nothing at all.
      const hub =
        link?.officer && isOfficerNode(entityId)
          ? officerHubNode(entityId, link.officer.name, link.officer.role)
          : null;

      const target = crawl.nodes.get(entityId) ?? borrowed.get(entityId) ?? hub;
      if (!target) return;


      // Whatever survived: a hub in the middle of a route resolves to nothing,
      // and a conduit can have been folded away since the trace ran.
      const drawable = route.filter((id) => crawl.nodes.get(id) ?? borrowed.get(id));
      const tiles = drawable.map((id) => crawl.nodes.get(id) ?? borrowed.get(id)!);

      // Which hops the graph already draws. Direction is not checked: an edge
      // between the two ends is the same connection whichever way it was filed.
      const drawn = new Set<string>();
      for (const e of crawl.edges.values()) drawn.add(`${e.source}|${e.target}`);

      const hops: GhostGraph['edges'] = [];
      for (let i = 1; i < drawable.length; i++) {
        const [near, far] = [drawable[i - 1], drawable[i]];
        if (drawn.has(`${near}|${far}`) || drawn.has(`${far}|${near}`)) continue;
        // The route reads outwards from the reader, so money coming in runs
        // back along it. Only the last hop knows its own amount.
        const paid = link?.flow === 'out' ? [near, far] : [far, near];
        hops.push({
          id: `ghost:${near}:${far}`,
          source: paid[0],
          target: paid[1],
          label: i === drawable.length - 1 ? (link?.label ?? '') : 'traced',
        });
      }

      const anyBorrowed = drawable.some((id) => !crawl.nodes.has(id));
      setGhost(anyBorrowed || hops.length > 0 ? { nodes: tiles, edges: hops } : null);
      setChain(drawable.length > 1 ? drawable : null);
      setSelected(target);
      pushTrail(target);
      requestFocus(entityId);
    },
    [crawl.nodes, crawl.edges, fetchNode, pushTrail, requestFocus, selected],
  );


  /**
   * Make this entity the one being searched, and crawl out from it.
   *
   * Replaces the subject outright rather than keeping the old one alongside:
   * once the graph is drawn around a different entity, the previous search is
   * no longer what is on screen, and a bar still naming it would be lying
   * about what you are looking at. Accepts any entity, including one reached
   * through the ledger that was never drawn.
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
        industry: node.industry,
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

  /**
   * Go back to the entity being searched, and forget the way here.
   *
   * The way out of an exploration rather than a way of changing it: the crawl,
   * its settings and its layout are all untouched, so this costs nothing to
   * press and nothing to undo. Reached four ways — the chip in the bar, a pill
   * over the canvas, escape, and clicking the seed's own tile.
   */
  const handleResetSelection = useCallback(() => {
    setChain(null);
    setGhost(null);
    setTrail([]);
    setPane('graph');
    const node = seed ? crawl.nodes.get(seed.id) : null;
    setSelected(node ?? null);
    if (node) requestFocus(node.id);
  }, [seed, crawl.nodes, requestFocus]);

  useEffect(() => {
    resetRef.current = handleResetSelection;
  }, [handleResetSelection]);

  /**
   * Run the search again from scratch.

   *
   * Everything an exploration accumulates goes: the selection, the route drawn
   * back to it, the tiles borrowed to draw that route, and any layout restored
   * from a saved search. A detour into registration links is undone too. What
   * survives is the entity being searched, which is what makes this a refresh
   * rather than a reset.
   */
  const handleRefreshCrawl = useCallback(() => {
    if (!seed) return;
    setChain(null);
    setGhost(null);
    setTrail([]);
    setSelected(null);
    setRestoredPositions(null);
    if (beforeRegistrations) {
      setSettings((prev) => ({ ...prev, ...beforeRegistrations }));
      setBeforeRegistrations(null);
    }
    // A fresh object rather than the same one: the crawl runs off `seed`
    // changing identity, and the id here is deliberately unchanged.
    setSeed({ ...seed });
    setPane('graph');
  }, [seed, beforeRegistrations]);

  /**
   * Redraw the graph on shared officers instead of money.
   *
   * The same switch as the control panel's third link mode, offered beside the
   * officers it acts on — which is where the question "who else does this
   * treasurer run?" actually comes up. What it replaces is remembered, so
   * refreshing can put it back.
   */
  const handleFindRegistrations = useCallback(() => {
    if (settings.linkMode === 'registration') return;
    setBeforeRegistrations({ linkMode: settings.linkMode, maxPerNode: settings.maxPerNode });
    setSettings(withLinkMode(settings, 'registration'));
  }, [settings]);


  /**
   * Settings changed by hand.
   *
   * Forgets what registration mode replaced, because the reader has now said
   * what they want and putting the old value back would undo their own change.
   */
  const handleSettingsChange = useCallback((next: CrawlSettings) => {
    if (next.linkMode !== 'registration') setBeforeRegistrations(null);
    setSettings(next);
  }, []);



  /**
   * Looking at something other than the entity searched.
   *
   * The one condition the whole exploration UI hangs off: it decides the chip
   * against the full column, whether the breadcrumb and the reset pill are
   * there at all, and how the viewing card and the panel header are accented.
   */
  const exploring = selectedNode !== null && seed !== null && selectedNode.id !== seed.id;

  /**
   * Tiles that stay readable however far the selection has wandered: the
   * entity searched, and everywhere the reader has been since.
   */
  const keepLit = useMemo(
    () => (seed ? [seed.id, ...trail.map((t) => t.id)] : []),
    [seed, trail],
  );

  let totalTracked = 0;


  for (const e of crawl.edges.values()) totalTracked += Number(e.amount);

  return (
    <div className="flex h-dvh flex-col bg-slate-950 text-slate-100">
      <div className="flex min-h-0 flex-1">
        {/* --------------------------------------------------------- sidebar */}
        {/* Runs the full height of the window and carries the masthead, so the
            search sits over the two panes it actually drives. */}
        <aside
          className={`w-full shrink-0 flex-col border-slate-800 lg:flex lg:w-72 lg:border-r
            ${pane === 'filters' ? 'flex' : 'hidden'}`}
        >
          <div className="hidden shrink-0 items-baseline gap-2 border-b border-slate-800 px-4 py-3 lg:flex">
            <h1 className="text-base font-semibold tracking-tight">PAC Tracker</h1>
            <span className="text-xs text-slate-500">Florida</span>
          </div>

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
              <ControlPanel settings={settings} onChange={handleSettingsChange} />

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
                  const saved: EntitySearchHit = {
                    id: s.seedEntityId,
                    name: s.seedName ?? 'seed',
                    kind: s.seedKind ?? 'unknown',
                    committee_type: null,
                    status: 'unknown',
                    city: null,
                    state_code: null,
                    industry: null,
                    total_received: '0',

                    total_given: '0',
                    in_degree: 0,
                    out_degree: 0,
                    is_traversable: true,
                    score: 1,
                  };
                  setSeed(saved);
                }}

              />
            )}
          </div>
        </aside>

        {/* Canvas and inspector under one search. Hidden on a phone whenever
            the sidebar has the screen, which is the only time they share it. */}
        <div
          className={`min-w-0 flex-1 flex-col lg:flex ${pane === 'filters' ? 'hidden' : 'flex'}`}
        >
      {/* ------------------------------------------------------------ header */}
      <header className="flex shrink-0 items-center gap-4 border-b border-slate-800 px-4 py-3">
        {/* The masthead is the sidebar's job from `lg` up. Below `sm` it is
            dropped instead of shown, because the search and the buttons
            together already want more width than a phone has. */}
        <h1 className="hidden shrink-0 text-sm font-semibold tracking-tight sm:block lg:hidden">
          PAC Tracker
        </h1>


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
          {/* Its own tab, not a route change: the guide is meant to be read
              while driving the graph, and navigating away would drop the
              crawl that prompted the question. */}
          <a
            href="/guide"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800"
          >
            Guide
          </a>
          <AccountButton />
        </div>
      </header>

          <div className="flex min-h-0 flex-1">
            {/* ------------------------------------------------------ canvas */}
            <main
              className={`relative flex min-w-0 flex-1 flex-col lg:flex ${
                pane === 'graph' ? 'flex' : 'hidden'
              }`}
            >
              {seed && (
                <SubjectBar
                  searched={seed}
                  searchedNode={crawl.nodes.get(seed.id) ?? null}
                  onRefresh={handleRefreshCrawl}
                  node={selectedNode}
                  onSearchFromHere={handleRecenter}
                  trail={trail}
                  onReturnToSearched={handleResetSelection}
                  onJumpTo={(hop) => void handleFocusEntity(hop.id)}

                  committees={subject?.committees ?? null}
                  received={received}
                  given={given}
                  direction={direction}
                  onDirectionChange={setDirection}
                  officers={searchedOfficers}
                  onFindRegistrations={handleFindRegistrations}
                  registrationsOn={settings.linkMode === 'registration'}
                />
              )}

              <div className="relative min-h-0 flex-1">
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
                    highlightChain={chain}
                    keepLit={keepLit}
                    ghost={ghost}
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
                {exploring && <ResetPill seedName={seed.name} onReset={handleResetSelection} />}

              </div>
            </main>

            {/* ------------------------------------------------------ detail */}
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
                subject={subject}
                officers={officers}
                direction={direction}
                onDirectionChange={setDirection}
                exploring={exploring}
                dateFrom={settings.dateFrom}

                dateTo={settings.dateTo}
                onDatesChange={(from, to) =>
                  setSettings((prev) => ({ ...prev, dateFrom: from, dateTo: to }))
                }
                cycle={settings.cycle}
              />

            </aside>
          </div>
        </div>
      </div>

      <MobileTabs pane={pane} onChange={setPane} hasSelection={selectedNode !== null} />
    </div>
  );
}

/** A kind's colour, as the dot that stands next to a name outside the canvas. */
function KindDot({ kind }: { kind: string }) {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: kindColor(kind) }}
      aria-hidden
    />
  );
}

/** The circular arrow that marks every control returning you to the search. */
function ReturnGlyph({ className }: { className?: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="-1 -1 26 26"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className ?? ''}`}
      aria-hidden
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

/**
 * One line about whichever entity the totals and the ledger belong to.
 *
 * The whole point of the card is that those numbers are attributable. Read on
 * its own it says who it is about, so a reader who scrolled to a figure cannot
 * carry it away attached to the wrong committee. The eyebrow says outright
 * whether that is the entity searched or one opened since.
 */
function ViewingCard({
  node,
  exploring,
  committees,
  received,
  given,
  direction,
  onDirectionChange,
  onSearchFromHere,
}: {
  node: GraphNode | null;
  exploring: boolean;
  committees: number | null;
  received: string;
  given: string;
  direction: LedgerDirection;
  onDirectionChange: (d: LedgerDirection) => void;
  onSearchFromHere: (nodeId: string) => void;
}) {
  // An officer hub is a person, and the crawl seeds on an entity id, so there
  // is no set of transactions to search from.
  const searchable = node !== null && !isOfficerNode(node.id);

  const meta = !node
    ? 'Click a tile, or a name in the panel'
    : node.kind === 'officer'
      ? `${node.office ?? 'officer'}${committees ? ` · named on ${committeeCount(committees)}` : ''}`
      : [
          kindLabel(node),
          node.office,
          node.status === 'closed' ? 'closed' : null,
          node.city ? `${node.city}, ${node.stateCode ?? ''}` : null,
          industryLabel(node),
        ]
          .filter(Boolean)
          .join(' · ');

  // Still the direction switch they always were. The active side loses the
  // dimming rather than gaining a border, so pressing one cannot be mistaken
  // for the card itself changing.
  const total = (label: string, value: string, side: 'in' | 'out') => {
    const on = direction === side;
    return (
      <button
        type="button"
        onClick={() => onDirectionChange(side)}
        title={`Show money ${side} in the panel`}
        className="rounded px-1 text-right transition hover:bg-slate-800/60"
      >
        <span
          className={`block text-[9px] font-semibold uppercase tracking-[0.1em] ${
            side === 'in' ? 'text-emerald-400' : 'text-amber-400'
          } ${on ? '' : 'opacity-70'}`}
        >
          {label}
        </span>
        <span
          className={`block font-mono text-base font-bold tabular-nums ${
            side === 'in' ? 'text-emerald-400' : 'text-amber-400'
          } ${on ? '' : 'opacity-70'}`}
        >
          {formatMoneyFull(value)}
        </span>
      </button>
    );
  };

  return (
    <div
      className={`flex items-center gap-[13px] rounded-xl border px-3 py-2.5 transition-[border-color,box-shadow] duration-200 ${
        exploring
          ? 'border-indigo-500 bg-indigo-950/45 shadow-[0_0_0_1px_rgba(99,102,241,0.25),0_8px_24px_rgba(49,46,129,0.35)]'
          : 'border-slate-800 bg-slate-900/50'
      }`}
    >
      <div className="min-w-[120px] max-w-xs">
        <span
          className={`block text-[9px] font-semibold uppercase tracking-[0.12em] ${
            exploring ? 'text-indigo-300' : 'text-slate-500'
          }`}
        >
          Viewing · {exploring ? 'selected' : 'searched'}
        </span>
        <span className="flex items-center gap-1.5">
          {node && <KindDot kind={node.kind} />}
          <span className="truncate text-sm font-semibold text-slate-100" title={node?.name}>
            {node?.name ?? 'Nothing selected'}
          </span>
        </span>
        <span className="block truncate text-[10.5px] text-slate-400" title={meta}>
          {meta}
        </span>
      </div>

      {exploring && node && (
        <button
          type="button"
          onClick={() => searchable && onSearchFromHere(node.id)}
          disabled={!searchable}
          title={
            searchable
              ? 'Make this the entity being searched and crawl out from it'
              : 'A person is not a search subject. Use Find linked registrations to draw their committees.'
          }
          className="shrink-0 rounded-lg bg-indigo-600 px-3 py-[7px] text-[11px] font-semibold
                     text-white transition hover:bg-indigo-500 disabled:opacity-40
                     disabled:hover:bg-indigo-600"
        >
          Search from here →
        </button>
      )}

      {node && (
        <div className="flex shrink-0 items-start gap-3">
          {total('Received', received, 'in')}
          {total('Given', given, 'out')}
        </div>
      )}
    </div>
  );
}

/**
 * The bar over the map: what you searched for, and what you are looking at now.
 *
 * Two identities, kept apart on purpose. The left names the entity the crawl
 * runs from and does not re-bind while you explore, so following a name out of
 * the ledger cannot cost you the thing you came to look at. The right names
 * whatever is open, and owns the totals — which is what stops a figure being
 * read off the wrong committee. Once the two differ the left collapses to a
 * chip and a breadcrumb of the hops taken, either of which puts you back.
 */
function SubjectBar({
  searched,
  searchedNode,
  onRefresh,
  node,
  onSearchFromHere,
  trail,
  onReturnToSearched,
  onJumpTo,
  committees,
  received,
  given,
  direction,
  onDirectionChange,
  officers,
  onFindRegistrations,
  registrationsOn,
}: {
  searched: EntitySearchHit;
  /** The crawl's own copy of it, which a saved search cannot supply. */
  searchedNode: GraphNode | null;
  onRefresh: () => void;
  node: GraphNode | null;
  onSearchFromHere: (nodeId: string) => void;
  /** Every tile opened since the search, oldest first. */
  trail: GraphNode[];
  onReturnToSearched: () => void;
  onJumpTo: (node: GraphNode) => void;
  /** Committees behind an officer hub, whose own totals are always zero. */
  committees: number | null;
  received: string;
  given: string;
  direction: LedgerDirection;
  onDirectionChange: (d: LedgerDirection) => void;
  /** Only the count is read now — whether there is anyone to hop on. */
  officers: EntityOfficer[];
  onFindRegistrations: () => void;
  registrationsOn: boolean;
}) {
  const exploring = node !== null && node.id !== searched.id;

  // The crawl's copy wins where there is one: a saved search restores a seed
  // with nothing but a name and an id filled in.
  const sector = industryLabel({
    kind: searched.kind,
    committeeType: searched.committee_type,
    industry: searchedNode?.industry ?? searched.industry,
  });
  const where = [
    kindLabel({ kind: searched.kind, committeeType: searched.committee_type }),
    searched.status === 'closed' ? 'closed' : null,
    searched.city ? `${searched.city}, ${searched.state_code ?? ''}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-slate-800 bg-slate-950 px-3.5 py-2.5">
      {/* Collapsed to a chip once something else is open: the searched entity
          is then a place to get back to rather than the subject on screen, and
          a whole column of detail about it is in the way of one. */}
      {exploring ? (
        <>
          <button
            type="button"
            onClick={onReturnToSearched}
            title="Return to your search (esc)"
            className="flex shrink-0 items-center gap-2.5 rounded-[10px] border border-slate-700
                       bg-slate-900 px-3 py-[7px] text-left transition
                       hover:border-indigo-500 hover:bg-indigo-950/40"
          >
            <ReturnGlyph className="text-indigo-400" />
            <span className="min-w-0">
              <span className="block text-[8.5px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                Searched · click to return
              </span>
              <span className="block max-w-[14rem] truncate text-[12.5px] font-semibold text-slate-200">
                {searched.name}
              </span>
            </span>
          </button>

          {/* Where you have been since, in the order you went. Any step is a
              way back to that point, and taking one drops everything after. */}
          <nav className="flex min-w-0 items-center gap-2 overflow-hidden" aria-label="Trail">
            {trail.map((hop, i) => (
              <span key={hop.id} className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-[13px] text-slate-600">›</span>
                <button
                  type="button"
                  onClick={() => onJumpTo(hop)}
                  title={i === trail.length - 1 ? hop.name : `Go back to ${hop.name}`}
                  className={`max-w-[11rem] truncate rounded-full px-[11px] py-1 text-[11px] transition ${
                    i === trail.length - 1
                      ? 'border border-indigo-500 bg-indigo-950 font-semibold text-indigo-100'
                      : 'border border-slate-700 font-medium text-slate-400 hover:border-indigo-400'
                  }`}
                >
                  {hop.name}
                </button>
              </span>
            ))}
          </nav>
        </>
      ) : (
        /* Fixed. This is the entity the crawl runs from, and it changes only
           when something else is made the entity the crawl runs from. */
        <div className="flex min-w-0 shrink flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-slate-600">Searched</span>

          <div className="flex min-w-0 items-center gap-2">
            <KindDot kind={searched.kind} />
            <span className="truncate text-base font-bold leading-tight" title={searched.name}>
              {searched.name}
            </span>
            <button
              type="button"
              onClick={onRefresh}
              title="Run this search again, dropping the selection and any detour into registration links"
              className={`flex ${BAR_BUTTON} border-indigo-500 bg-indigo-950/60 text-slate-100
                          hover:bg-indigo-900/60`}
            >
              <ReturnGlyph />
              Refresh crawl
            </button>
          </div>

          <span className="truncate text-[11px] leading-tight text-slate-400">{where}</span>
          {sector && (
            <span
              className="truncate text-[11px] leading-tight text-slate-400"
              title="Industry, as classified from the filings"
            >
              {sector}
            </span>
          )}

          {/* The one question the officers always prompt, without the roster
              itself — the chair and treasurer now live in the panel, beside
              the rest of this entity's detail. Absent where the state recorded
              no officers, since there is then nothing to hop on. */}
          {officers.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
              <button
                type="button"
                onClick={onFindRegistrations}
                disabled={registrationsOn}
                title={
                  registrationsOn
                    ? 'The graph is already following registration links'
                    : 'Redraw the graph on shared officers instead of money'
                }
                className="flex shrink-0 items-center gap-1.5 rounded border border-violet-700
                           bg-violet-950/50 px-2.5 py-1 text-xs font-medium text-violet-200
                           transition hover:border-violet-500 hover:bg-violet-900/50
                           disabled:opacity-40 disabled:hover:bg-violet-950/50"
              >
                <BarIcon>
                  <circle cx="6" cy="6" r="2.5" />
                  <circle cx="18" cy="18" r="2.5" />
                  <path d="M8.4 7.6 15.6 15.6" />
                </BarIcon>
                Find linked registrations
              </button>
            </div>
          )}
        </div>
      )}

      <div className="ml-auto hidden shrink-0 lg:block">
        <ViewingCard
          node={node}
          exploring={exploring}
          committees={committees}
          received={received}
          given={given}
          direction={direction}
          onDirectionChange={onDirectionChange}
          onSearchFromHere={onSearchFromHere}
        />
      </div>
    </div>
  );
}

/**
 * The way out of an exploration, over the map rather than beside it.
 *
 * The bar's chip does the same thing, but the reader's attention is on the
 * graph by the time they want it, and a control at the top of the screen is
 * not where they are looking. Names the destination rather than saying "back",
 * so it cannot be read as undoing the last click.
 */
function ResetPill({ seedName, onReset }: { seedName: string; onReset: () => void }) {
  return (
    <button
      type="button"
      onClick={onReset}
      className="absolute bottom-[18px] left-1/2 flex -translate-x-1/2 items-center gap-2
                 rounded-full bg-indigo-600 px-[18px] py-2.5 text-xs font-semibold text-white
                 shadow-[0_8px_24px_rgba(79,70,229,0.35)] transition hover:bg-indigo-500"
    >
      <ReturnGlyph />
      <span className="max-w-[18rem] truncate">Back to {seedName}</span>
      <span className="rounded border border-white/35 px-[5px] py-px text-[10px] font-medium">
        esc
      </span>
    </button>
  );
}

/** Shared by the bar's buttons, so they read as one set of controls. */
const BAR_BUTTON =
  'shrink-0 items-center gap-1.5 rounded border border-slate-700 px-2 py-1 text-[11px] ' +
  'text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-transparent';

/**
 * One 12px stroke glyph, sized and weighted the same for every bar button.
 *
 * The viewBox is a unit larger than the 24-grid the paths are drawn on, so a
 * stroke that runs to the edge is not clipped at this size.
 */
function BarIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="-1 -1 26 26"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden
    >
      {children}
    </svg>
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
