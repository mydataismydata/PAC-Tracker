'use client';

/**
 * Cytoscape canvas for the money-flow graph.
 *
 * Two behaviours matter most here:
 *
 *  1. Incremental growth. Levels stream in, so elements are added in batches and
 *     the layout runs only over *new* nodes, with already-placed nodes locked.
 *     Re-running a global layout on every batch would make tiles jump around
 *     while the user is reading them.
 *
 *  2. Manual arrangement survives. Any node the user drags is pinned, so later
 *     levels arrange themselves around the user's layout instead of discarding
 *     it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, {
  type Core,
  type ElementDefinition,
  type NodeSingular,
  type EventObject,
} from 'cytoscape';
import fcose from 'cytoscape-fcose';
import {
  KIND_COLORS,
  formatMoney,

  type GraphEdge,
  type GraphNode,
  type ViewIntent,
} from '@/lib/graph/types';

cytoscape.use(fcose);

/** Uniform tile geometry. See the node style for why these are not 'label'. */
const TILE_W = 168;
const TILE_H = 58;

/** How far each ghost tile is stepped off the one before it. */
const GHOST_DX = TILE_W + 150;
const GHOST_DY = TILE_H + 70;

/** Trim a name to what fits two lines of a tile without overflowing it. */
function fitLabel(name: string, max = 38): string {
  const clean = name.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}


/**
 * Deterministic starting point for a newly added tile.
 *
 * Golden-angle placement spreads consecutive nodes evenly around the ring
 * rather than clumping them, and deeper levels start further out so the force
 * layout usually converges to a roughly concentric arrangement by BFS depth.
 */
function spawnPosition(
  origin: { x: number; y: number },
  spread: number,
  index: number,
  level: number,
): { x: number; y: number } {
  const angle = index * 2.399963; // golden angle in radians
  const radius = spread * (0.5 + 0.35 * level) * (0.65 + 0.35 * Math.sqrt(index + 1) * 0.15);
  return {
    x: origin.x + Math.cos(angle) * radius,
    y: origin.y + Math.sin(angle) * radius,
  };
}

export interface GraphCanvasHandle {
  exportPng: (filename: string) => void;
  fit: () => void;
  /** Centre and zoom on one node. False when it is not on the canvas. */
  focusOn: (nodeId: string) => boolean;
  getPositions: () => Record<string, { x: number; y: number }>;
  /** Multiply the zoom about the viewport centre. >1 zooms in. */
  zoomBy: (factor: number) => void;
  /** Pan by a fraction of the viewport; +x moves the view right. */
  panBy: (dx: number, dy: number) => void;
  /** Re-measure the container after it has been hidden and shown again. */
  resize: () => void;
}

/** One press of + or −. */
export const ZOOM_STEP = 1.3;
/** One arrow-key press, as a share of the viewport. */
export const PAN_STEP = 0.2;

/** Zoom level used when homing in on a single entity. */
const FOCUS_ZOOM = 1.1;

/**
 * Dim everything except a node and the tiles it trades with.
 *
 * Shared by tapping a tile and by focusing one from search or the ledger, so
 * an entity reached any of those ways reads the same on the canvas.
 */
function highlightNeighborhood(cy: Core, node: NodeSingular, keepLit: string[] = []): void {
  cy.elements().addClass('dimmed').removeClass('highlighted');
  for (const id of keepLit) {
    const el = cy.getElementById(id);
    if (el.nonempty() && el.isNode()) el.removeClass('dimmed');
  }
  node.closedNeighborhood().removeClass('dimmed').addClass('highlighted');
}

/**
 * Dim everything except one route through the graph.
 *
 * Used where the interesting thing is not who a tile trades with but how it
 * connects back to the entity the reader started from — a donor several
 * transfers upstream, say, whose neighbourhood says nothing about why it is on
 * screen. Returns false when the route has fewer than two tiles drawn, so the
 * caller can fall back to the neighbourhood rather than dimming the whole map
 * down to a single tile.
 */
function highlightRoute(cy: Core, chain: string[], keepLit: string[]): boolean {
  const hops = chain
    .map((id) => cy.getElementById(id))
    .filter((el) => el.nonempty() && el.isNode());
  if (hops.length < 2) return false;

  let route = cy.collection();
  for (const [i, hop] of hops.entries()) {
    route = route.union(hop);
    // Either direction: a chain is a route the money took, and the edge
    // recording it points whichever way the filing did.
    if (i > 0) route = route.union(hops[i - 1].edgesWith(hop));
  }

  // Tiles that stay readable without being part of this route — the seed and
  // everywhere the reader has been. Nodes only: two tiles being on the same
  // trail says nothing about money passing between them, and lighting an edge
  // would claim it did.
  let lit = cy.collection();
  for (const id of keepLit) {
    const el = cy.getElementById(id);
    if (el.nonempty() && el.isNode()) lit = lit.union(el);
  }

  cy.elements().addClass('dimmed').removeClass('highlighted');
  lit.removeClass('dimmed');
  route.removeClass('dimmed').addClass('highlighted');
  return true;
}

/**
 * Tiles pulled onto the canvas to show a link the crawl itself did not draw.
 *
 * The graph is a filtered slice — in `direct` mode an individual donor is
 * never drawn at all — so a row in the ledger routinely names an entity with
 * no tile. Rather than have the click do nothing visible, the parent hands
 * over the missing tiles and the hops joining them, and they are laid in
 * beside the graph without disturbing it.
 */
export interface GhostGraph {
  /** Route order, the anchor already on the canvas first. */
  nodes: GraphNode[];
  edges: { id: string; source: string; target: string; label: string }[];
}


interface Props {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  seedId: string | null;
  /** Restored layout from a saved search. */
  initialPositions?: Record<string, { x: number; y: number }> | null;
  onSelectNode?: (node: GraphNode | null) => void;
  /** Double-click re-roots the crawl on that node. */
  onExpandNode?: (nodeId: string) => void;
  onReady?: (handle: GraphCanvasHandle) => void;
  /**
   * What to do with the viewport, raised by the parent as a token.
   *
   * The canvas is lazily loaded and a crawl over warm data can complete before
   * Cytoscape has mounted, so the parent cannot just call fit()/focusOn()
   * itself — it states an intent and the canvas acts as soon as it is able,
   * retrying until the target node actually exists.
   */
  viewIntent?: ViewIntent;
  /** Entity selected elsewhere (search, ledger), mirrored into the canvas. */
  selectedId?: string | null;
  /**
   * The route back from the selection to where the reader came from.
   *
   * Takes the place of the neighbourhood highlight when present, so following
   * money out of the panel shows the connection rather than a fresh, unrelated
   * cluster around wherever you landed.
   */
  highlightChain?: string[] | null;
  /**
   * Tiles to leave readable whatever else is dimmed.
   *
   * The entity being searched and every tile the reader has opened on the way
   * here, so the path taken through the graph stays visible behind whatever is
   * currently in focus.
   */
  keepLit?: string[];
  /** Tiles to lay in for the parts of that route the crawl never drew. */
  ghost?: GhostGraph | null;
}

/**
 * A tile's full label: name on the first line, money on the second.
 *
 * Returns the *whole* label rather than just the money, because both the add
 * and the relabel path use it. Returning only the money line once meant a
 * cycle switch rewrote a surviving tile's label to its amount alone and threw
 * the name away.
 */
function tileLabel(n: GraphNode): string {
  // An officer hub is a person. "in $0 · out $0" on one would read as a party
  // to the money rather than the reason the committees around it are grouped.
  if (n.kind === 'officer') {
    return [fitLabel(n.name), n.office ?? ''].filter(Boolean).join('\n');
  }
  const received = Number(n.totalReceived);
  const given = Number(n.totalGiven);
  const money =
    received > 0 && given > 0
      ? `in ${formatMoney(received)} · out ${formatMoney(given)}`
      : received > 0
        ? `in ${formatMoney(received)}`
        : given > 0
          ? `out ${formatMoney(given)}`
          : '';
  return [fitLabel(n.name), money].filter(Boolean).join('\n');
}

export default function GraphCanvas({
  nodes,
  edges,
  seedId,
  initialPositions,
  onSelectNode,
  onExpandNode,
  onReady,
  viewIntent,
  selectedId,
  highlightChain,
  keepLit,
  ghost,
}: Props) {


  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  /** Nodes the user has dragged; never re-laid-out. */
  const pinnedRef = useRef<Set<string>>(new Set());
  /** The in-flight layout, so a new batch can cancel it instead of racing it. */
  const layoutRef = useRef<cytoscape.Layouts | null>(null);
  const relayoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The route to favour over the neighbourhood, readable from a callback.
   *
   * `focusOn` and the tap handler are created once and live for the lifetime of
   * the canvas, so neither can close over the current prop. A ref lets both ask
   * what the route is at the moment they run.
   */
  const chainRef = useRef<string[] | null>(null);
  const keepLitRef = useRef<string[]>([]);
  /**
   * Bumped every time a Cytoscape instance is created.
   *
   * A plain `ready` boolean is not enough: React StrictMode (and any remount)
   * tears the instance down and builds a new one, but the boolean stays `true`
   * throughout, so effects keyed on it never re-run and end up addressing the
   * destroyed instance — leaving the live canvas unpopulated and unfitted.
   */
  const [cyEpoch, setCyEpoch] = useState(0);
  const ready = cyEpoch > 0;

  // Edge widths are scaled against the largest edge currently on screen, so the
  // relative weighting stays readable whether the graph spans $900 or $9M.
  const maxAmount = useMemo(() => {
    let max = 0;
    for (const e of edges.values()) max = Math.max(max, Number(e.amount));
    return max || 1;
  }, [edges]);

  /**
   * Highlight a tile the way the reader arrived at it.
   *
   * A route wins where there is one, because someone who clicked a name in the
   * panel is asking how it connects to what they were already looking at. A
   * tap on the tile itself asks the other question, so it keeps the
   * neighbourhood.
   */
  const applyHighlight = useCallback((cy: Core, node: NodeSingular) => {
    const chain = chainRef.current;
    if (chain && chain.length > 1 && highlightRoute(cy, chain, keepLitRef.current)) return;
    highlightNeighborhood(cy, node, keepLitRef.current);
  }, []);

  /* ---------------------------------------------------------------- init -- */
  useEffect(() => {
    if (!containerRef.current || cyRef.current) return;


    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      minZoom: 0.05,
      maxZoom: 4,
      wheelSensitivity: 0.2,
      // textureOnViewport/motionBlur leave stale ghost tiles behind while
      // levels stream in and the layout is animating. Correctness of what is
      // on screen matters more here than pan smoothness.
      textureOnViewport: false,
      motionBlur: false,
      pixelRatio: 1.5,
      style: [
        {
          selector: 'node',
          style: {
            shape: 'round-rectangle',
            'background-color': (n: NodeSingular) =>
              KIND_COLORS[n.data('kind') as string] ?? KIND_COLORS.unknown,
            'background-opacity': 0.16,
            'border-width': 1.5,
            'border-color': (n: NodeSingular) =>
              KIND_COLORS[n.data('kind') as string] ?? KIND_COLORS.unknown,
            label: 'data(label)',
            color: '#e2e8f0',
            'font-size': 10,
            'font-weight': 500,
            'text-wrap': 'wrap',
            'text-max-width': `${TILE_W - 16}px`,
            'text-valign': 'center',
            'text-halign': 'center',
            // Explicit dimensions, NOT width/height: 'label'. Auto-sizing leaves
            // some nodes with an unresolved size, which makes Cytoscape report
            // them invisible and silently cull every edge attached to them.
            width: TILE_W,
            height: TILE_H,
            'line-height': 1.3,
          },
        },
        {
          // The seed reads as the anchor of the whole view.
          selector: 'node[?isSeed]',
          style: {
            'border-width': 3,
            'border-color': '#f8fafc',
            'background-opacity': 0.32,
            'font-size': 11,
            'font-weight': 700,
            width: TILE_W + 26,
            height: TILE_H + 12,
            'z-index': 10,
          },
        },
        {
          // A person, not a committee. Shaped and coloured unlike any tile so
          // it cannot be mistaken for something that holds or moves money.
          selector: 'node[kind = "officer"]',
          style: {
            shape: 'ellipse',
            'background-color': '#7c3aed',
            'background-opacity': 0.3,
            'border-width': 2,
            'border-color': '#a78bfa',
            'border-style': 'dashed',
            color: '#ddd6fe',
            'font-size': 11,
            'font-weight': 700,
            width: 132,
            height: 132,
            'z-index': 12,
          },
        },
        {
          selector: 'node:selected',
          style: { 'border-width': 3, 'border-color': '#fbbf24', 'background-opacity': 0.35 },
        },
        {
          // A node that can still be crawled further gets a dashed outline.
          selector: 'node[?hasMore]',
          style: { 'border-style': 'dashed' },
        },
        {
          selector: 'edge',
          style: {
            width: 'data(width)',
            'line-color': '#475569',
            'target-arrow-color': '#64748b',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.9,
            'curve-style': 'bezier',
            opacity: 0.55,
            label: 'data(label)',
            'font-size': 9,
            color: '#94a3b8',
            'text-background-color': '#0f172a',
            'text-background-opacity': 0.85,
            'text-background-padding': '2px',
            'text-rotation': 'autorotate',
          },
        },
        {
          // Committee-to-committee money is the story; individual gifts recede.
          selector: 'edge[?isDirectLink]',
          style: { 'line-color': '#818cf8', 'target-arrow-color': '#818cf8', opacity: 0.75 },
        },
        {
          // Paperwork, not payment. Dashed and arrowless so it cannot be read
          // as a direction of money, which is the one misreading that would
          // turn a shared accountant into a transfer that never happened.
          selector: 'edge[kind = "registration"]',
          style: {
            'line-style': 'dashed',
            'line-dash-pattern': [5, 4],
            'line-color': '#7c3aed',
            'target-arrow-shape': 'none',
            'source-arrow-shape': 'none',
            width: 1,
            opacity: 0.45,
            color: '#a78bfa',
          },
        },
        {
          selector: 'edge:selected',
          style: { 'line-color': '#fbbf24', 'target-arrow-color': '#fbbf24', opacity: 1 },
        },
        {
          // Not part of the crawl — pulled in to show one link. Dotted so it
          // cannot be read as a tile the current settings would have drawn.
          selector: 'node.ghost',
          style: {
            'border-style': 'dotted',
            'border-width': 2,
            'background-opacity': 0.1,
          },
        },
        {
          selector: 'edge.ghost',
          style: {
            'line-style': 'dotted',
            'line-color': '#94a3b8',
            'target-arrow-color': '#94a3b8',
            width: 2,
            opacity: 0.7,
          },
        },
        {
          selector: '.dimmed',
          style: { opacity: 0.12, 'text-opacity': 0 },
        },

        {
          selector: '.highlighted',
          style: { opacity: 1, 'text-opacity': 1 },
        },
        {
          // A hop on the route the reader is following. Lighter and thicker
          // than the same edge unhighlighted, so the line can be traced across
          // a dimmed graph without hunting for it.
          selector: 'edge.highlighted',
          style: {
            'line-color': '#818cf8',
            'target-arrow-color': '#818cf8',
            width: 3,
            color: '#c7d2fe',
            'font-size': 9.5,
            'text-background-color': '#1e1b4b',
            'text-background-opacity': 1,
            'text-background-padding': '3px',
            'text-border-color': '#6366f1',
            'text-border-opacity': 1,
            'text-border-width': 1,
            'text-background-shape': 'roundrectangle',
          },
        },

      ],
    });

    cy.on('tap', 'node', (evt: EventObject) => {
      const n = evt.target as NodeSingular;
      onSelectNode?.(n.data('entity') as GraphNode);
      highlightNeighborhood(cy, n);
    });

    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) {
        cy.elements().removeClass('dimmed').removeClass('highlighted');
        onSelectNode?.(null);
      }
    });

    cy.on('dbltap', 'node', (evt: EventObject) => {
      onExpandNode?.((evt.target as NodeSingular).id());
    });

    // Dragging a node pins it so later layout passes leave it alone.
    cy.on('dragfree', 'node', (evt: EventObject) => {
      pinnedRef.current.add((evt.target as NodeSingular).id());
    });

    cyRef.current = cy;
    setCyEpoch((e) => e + 1);

    // Handy for poking at the graph from the browser console during development.
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as { cy?: Core }).cy = cy;
    }

    // Cytoscape caches the container size at construction. In a flex layout the
    // pane is often still 0-sized then, which leaves the first fit centred on
    // the wrong box and the seed tile clipped at the corner.
    const ro = new ResizeObserver(() => {
      cy.resize();
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      if (relayoutTimer.current) clearTimeout(relayoutTimer.current);
      layoutRef.current?.stop();
      cy.destroy();
      cyRef.current = null;
    };
    // Handlers are stable for the lifetime of the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------- syncing -- */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !ready) return;

    const nodeDefs: ElementDefinition[] = [];
    const edgeDefs: ElementDefinition[] = [];

    // The hook resets its maps when a crawl restarts, so `nodes` and `edges`
    // are the whole truth for the current crawl, not a delta. Anything on the
    // canvas that is missing from them belongs to a superseded graph: changing
    // the cycle used to leave the previous cycle's tiles sitting underneath the
    // new ones.
    const stale = cy.elements().filter((el) => {
      // Ghosts are the parent's to add and remove; they are absent from these
      // maps by definition, and sweeping them here would delete each one in
      // the same beat it was laid in.
      if (el.hasClass('ghost')) return false;
      const id = el.id();
      return el.isNode() ? !nodes.has(id) : !edges.has(id);
    });
    if (stale.nonempty()) cy.remove(stale);

    // Totals are cycle-dependent, so a node that survives the change still
    // needs its label rewritten.
    for (const n of nodes.values()) {
      const el = cy.getElementById(n.id);
      if (el.empty()) continue;
      const label = tileLabel(n);
      if (el.data('label') !== label) el.data({ label, entity: n });
    }

    // Cytoscape drops every positionless node at (0,0). A force layout started
    // from identical coordinates has no gradient to push against, so the whole
    // level stays welded into one pile. Seed each newcomer on a ring around the
    // existing graph's centre instead, and let the layout relax from there.
    const existing = cy.nodes();
    const centre = existing.length > 0 ? existing.boundingBox() : null;
    const origin = centre
      ? { x: (centre.x1 + centre.x2) / 2, y: (centre.y1 + centre.y2) / 2 }
      : { x: 0, y: 0 };
    const spread = centre ? Math.max(centre.w, centre.h, 400) * 0.7 : 400;
    let spawnIndex = 0;

    for (const n of nodes.values()) {
      if (cy.getElementById(n.id).nonempty()) continue;


      nodeDefs.push({
        group: 'nodes',
        data: {
          id: n.id,
          label: tileLabel(n),
          fullName: n.name,
          kind: n.kind,
          isSeed: n.id === seedId,
          // Dashed border hints there is more to pull in beyond what is drawn.
          hasMore: n.isTraversable && n.inDegree + n.outDegree > 0,
          entity: n,
        },
        position: initialPositions?.[n.id]
          ? { ...initialPositions[n.id] }
          : spawnPosition(origin, spread, spawnIndex++, n.level),
      });
    }

    for (const e of edges.values()) {
      if (cy.getElementById(e.id).nonempty()) continue;
      // Both endpoints must exist before Cytoscape will accept the edge.
      if (!nodes.has(e.source) || !nodes.has(e.target)) continue;

      const amount = Number(e.amount);
      // Log scale: contributions span five orders of magnitude, so a linear
      // width would render everything below the top donor as a hairline.
      const width = 1 + (Math.log10(amount + 1) / Math.log10(maxAmount + 1)) * 7;

      const isRegistration = e.kind === 'registration';

      edgeDefs.push({
        group: 'edges',
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          width: isRegistration ? 1 : Number.isFinite(width) ? width : 1,
          // A registration edge labelled "$0" would read as a payment of
          // nothing rather than as no payment at all, so it names the role.
          label: isRegistration ? (e.basis ?? 'shared officer') : formatMoney(amount),
          isDirectLink: e.isDirectLink,
          kind: e.kind,
          amount: isRegistration ? 0 : amount,
          txnCount: e.txnCount,
          edge: e,
        },
      });
    }

    if (nodeDefs.length === 0 && edgeDefs.length === 0) return;

    // Track which ids are new *before* adding, so membership tests are cheap
    // and do not depend on collection identity.
    const newNodeIds = new Set(nodeDefs.map((d) => String(d.data.id)));
    if (newNodeIds.size === 0 && edgeDefs.length === 0) return;

    cy.batch(() => {
      if (nodeDefs.length) cy.add(nodeDefs);
      if (edgeDefs.length) cy.add(edgeDefs);
    });

    // Adding only edges between existing nodes needs no relayout.
    if (newNodeIds.size === 0) return;

    /**
     * Levels stream in milliseconds apart, and starting a layout while another
     * is still animating leaves the second batch stranded on top of the first —
     * stacked tiles, and zero-length edges that the renderer then culls. So
     * coalesce bursts into a single pass and cancel any layout still running.
     */
    if (relayoutTimer.current) clearTimeout(relayoutTimer.current);
    relayoutTimer.current = setTimeout(() => {
      layoutRef.current?.stop();

      // Hold pinned and user-restored tiles; let everything else settle freely
      // so late arrivals don't get wedged into whatever gap is left over.
      const fixed: { nodeId: string; position: { x: number; y: number } }[] = [];
      cy.nodes().forEach((n) => {
        const id = n.id();
        if (pinnedRef.current.has(id) || initialPositions?.[id]) {
          const p = n.position();
          fixed.push({ nodeId: id, position: { x: p.x, y: p.y } });
        }
      });

      const layout = cy.layout({
        name: 'fcose',
        quality: 'proof',
        animate: true,
        animationDuration: 500,
        randomize: fixed.length === 0,
        fit: false,
        padding: 60,
        // Tuned for 168x58 tiles: without generous repulsion and edge length,
        // a hub committee's spokes pile on top of each other and the labels
        // become unreadable.
        nodeDimensionsIncludeLabels: true,
        nodeSeparation: 220,
        idealEdgeLength: 300,
        nodeRepulsion: 60000,
        gravity: 0.15,
        gravityRange: 3.8,
        numIter: 3000,
        tile: true,
        fixedNodeConstraint: fixed.length > 0 ? fixed : undefined,
      } as cytoscape.LayoutOptions);

      /**
       * fcose's own `fit` runs against the size it saw at layout start, which
       * in a flex pane is often stale, so this is the fit that counts. Skipped
       * once the user has arranged tiles by hand — their layout wins.
       */
      const settleView = () => {
        if (pinnedRef.current.size > 0) return;
        cy.resize();
        cy.fit(cy.elements(), 60);
        if (cy.zoom() > 1.2) {
          cy.zoom(1.2);
          cy.center();
        }
      };

      // `layoutstop` does not fire when a layout is stopped early by the next
      // batch, so back it with a timer rather than leaving the view unfitted.
      layout.one('layoutstop', settleView);
      const fitFallback = setTimeout(settleView, 900);
      layout.one('layoutstop', () => clearTimeout(fitFallback));

      layoutRef.current = layout;
      layout.run();
    }, 180);
    // cyEpoch is a dependency so a rebuilt instance gets repopulated; without
    // it a remount leaves the new canvas permanently empty. `ready` is derived
    // from cyEpoch and listed only to satisfy exhaustive-deps.
  }, [nodes, edges, seedId, maxAmount, cyEpoch, ready, initialPositions]);

  /* ------------------------------------------------------------- handle --- */
  const exportPng = useCallback((filename: string) => {
    const cy = cyRef.current;
    if (!cy) return;
    const png = cy.png({
      output: 'blob',
      bg: '#0f172a',
      full: true,
      scale: 2,
      maxWidth: 6000,
      maxHeight: 6000,
    });
    const url = URL.createObjectURL(png);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.png') ? filename : `${filename}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  /**
   * Frame the whole graph.
   *
   * Returns false when the container currently has no size — a hidden tab, a
   * collapsed pane, or a mid-transition flex box. Fitting to a 0x0 viewport
   * silently produces a degenerate result and leaves the graph stranded
   * off-screen, so callers retry instead.
   */
  const fit = useCallback((): boolean => {
    const cy = cyRef.current;
    if (!cy || cy.elements().empty()) return false;

    const el = cy.container();
    if (!el || el.clientWidth < 2 || el.clientHeight < 2) return false;
    // Stop the layout first. Fitting while nodes are still animating measures a
    // bounding box that is obsolete by the time they land, which is why an
    // animated fit here silently appeared to do nothing.
    layoutRef.current?.stop();
    cy.stop();
    // resize() next: the container may have been laid out after Cytoscape last
    // measured it, and fitting to a stale box leaves tiles off-screen.
    cy.resize();
    cy.fit(cy.elements(), 60);
    if (cy.zoom() > 1.2) {
      cy.zoom(1.2);
      cy.center();
    }
    return true;
  }, []);

  /**
   * Centre and zoom on one node, and mark it selected.
   *
   * Returns false when the node is not on the canvas yet — levels stream in, so
   * callers retry rather than give up.
   */
  const focusOn = useCallback((nodeId: string): boolean => {
    const cy = cyRef.current;
    if (!cy) return false;

    const node = cy.getElementById(nodeId);
    if (node.empty() || !node.isNode()) return false;

    const el = cy.container();
    if (!el || el.clientWidth < 2 || el.clientHeight < 2) return false;

    layoutRef.current?.stop();
    cy.stop();
    cy.resize();

    cy.nodes().unselect();
    node.select();
    applyHighlight(cy, node as NodeSingular);

    cy.animate({
      center: { eles: node },
      zoom: Math.min(FOCUS_ZOOM, cy.maxZoom()),
      duration: 380,
      easing: 'ease-out',
    });
    return true;
  }, [applyHighlight]);

  /**
   * Step the zoom about the centre of the viewport.
   *
   * Multiplicative, not additive: zoom is a scale, so a fixed step feels
   * enormous when zoomed out and imperceptible when zoomed in. Anchored on the
   * viewport centre rather than the pointer, since the caller is a button and
   * has no pointer position to speak of.
   */
  const zoomBy = useCallback((factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    layoutRef.current?.stop();
    cy.stop();
    const next = Math.min(cy.maxZoom(), Math.max(cy.minZoom(), cy.zoom() * factor));
    // Set rather than animate. An animated zoom rides requestAnimationFrame,
    // which a backgrounded tab stalls — the graph then jumps when the tab comes
    // forward, or not at all. A discrete step wants no easing anyway.
    //
    // `cy.width()`, not `container().clientWidth`: Cytoscape's own measure of
    // its viewport, which is what `renderedPosition` is expressed in.
    cy.zoom({ level: next, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }, []);

  /**
   * Pan by a fraction of the viewport.
   *
   * Proportional rather than a fixed pixel count so one press moves the same
   * share of what is on screen at any zoom level.
   */
  const panBy = useCallback((dx: number, dy: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    layoutRef.current?.stop();
    cy.stop();
    // Sign is inverted because panning the viewport right means moving the
    // scene left. `cy.width()` for the same reason as `zoomBy`.
    cy.panBy({ x: -dx * cy.width(), y: -dy * cy.height() });
  }, []);

  const getPositions = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return {};
    const out: Record<string, { x: number; y: number }> = {};
    cy.nodes().forEach((n) => {
      const p = n.position();
      out[n.id()] = { x: p.x, y: p.y };
    });
    return out;
  }, []);

  /**
   * Re-measure the container.
   *
   * Cytoscape caches its viewport size, so a canvas that was `display: none`
   * while another pane showed comes back convinced it is 0x0 and renders
   * nothing until something forces a measure. The mobile pane switcher hides
   * it on every tab change, so the graph pane calls this on the way back in.
   */
  const resize = useCallback(() => {
    const cy = cyRef.current;
    const el = cy?.container();
    if (!cy || !el || el.clientWidth < 2 || el.clientHeight < 2) return;
    cy.resize();
  }, []);

  useEffect(() => {
    if (ready) onReady?.({ exportPng, fit, focusOn, getPositions, zoomBy, panBy, resize });
  }, [ready, exportPng, fit, focusOn, getPositions, zoomBy, panBy, resize, onReady]);

  // A new seed means a new graph; whatever the user pinned belonged to the old
  // one and must not constrain the fresh layout.
  useEffect(() => {
    pinnedRef.current.clear();
  }, [seedId]);

  // Frame the finished graph once the layout animation has settled. Waits for
  // `ready`, so a crawl that outruns the canvas mount still gets fitted. The
  // token is an explicit request from the parent, so it is not second-guessed
  // against pinning here — only the layout-driven refits defer to that.
  useEffect(() => {
    if (!ready || !viewIntent || viewIntent.token === 0) return;

    // Poll until the action actually lands. The first attempt waits for the
    // debounced layout; later ones cover a container that was not yet sized
    // (hidden tab, collapsed pane) or a target node that has not streamed in
    // yet when the earlier attempts ran.
    let attempts = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const attempt = () => {
      const done = viewIntent.kind === 'focus' ? focusOn(viewIntent.nodeId) : fit();
      if (done || attempts >= 8) return;
      attempts++;
      timers.push(setTimeout(attempt, 400));
    };
    timers.push(setTimeout(attempt, 800));

    return () => timers.forEach(clearTimeout);
  }, [viewIntent, cyEpoch, ready, fit, focusOn]);

  // Declared above the two effects that read it, so a route arriving with a
  // selection is in place before the highlight for that selection runs.
  useEffect(() => {
    chainRef.current = highlightChain ?? null;
    keepLitRef.current = keepLit ?? [];
  }, [highlightChain, keepLit]);

  /**
   * Lay in the route's missing tiles, and take the previous set away.

   *
   * Placed by stepping off whichever tile of the route is already on screen,
   * never by running a layout: a layout pass moves every other tile on the
   * canvas, which is the precise disorientation this exists to prevent. Only
   * one route's worth of ghosts is ever present, so following a second name
   * clears the first rather than silting the map up.
   */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !ready) return;

    cy.batch(() => {
      cy.remove(cy.elements('.ghost'));
      if (!ghost || ghost.nodes.length === 0) return;

      const drawn = cy.nodes();
      const box = drawn.nonempty() ? drawn.boundingBox() : null;
      let from = box ? { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 } : { x: 0, y: 0 };
      let step = 0;

      for (const n of ghost.nodes) {
        const already = cy.getElementById(n.id);
        if (already.nonempty()) {
          from = already.position();
          continue;
        }
        step++;
        // Fanned above and below the line so a long route does not lay its
        // tiles end to end off the edge of the viewport.
        const position = {
          x: from.x - GHOST_DX,
          y: from.y + (step % 2 === 1 ? -GHOST_DY : GHOST_DY),
        };
        cy.add({
          group: 'nodes',
          classes: 'ghost',
          data: {
            id: n.id,
            label: tileLabel(n),
            fullName: n.name,
            kind: n.kind,
            isSeed: false,
            hasMore: false,
            entity: n,
          },
          position,
        });
        from = position;
      }

      for (const e of ghost.edges) {
        if (cy.getElementById(e.id).nonempty()) continue;
        // Both ends have to exist first, and one of them can be an officer hub
        // that this route never managed to resolve.
        if (cy.getElementById(e.source).empty() || cy.getElementById(e.target).empty()) continue;
        cy.add({
          group: 'edges',
          classes: 'ghost',
          data: { id: e.id, source: e.source, target: e.target, label: e.label, width: 2 },
        });
      }
    });
  }, [ghost, cyEpoch, ready]);

  /**
   * Mirror a selection made outside the canvas.

   *
   * Selecting from search or the ledger should look the same as tapping the
   * tile — otherwise the panel and the canvas disagree about what is selected.
   */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !ready) return;

    if (!selectedId) {
      cy.nodes().unselect();
      cy.elements().removeClass('dimmed').removeClass('highlighted');
      return;
    }

    const node = cy.getElementById(selectedId);
    if (node.empty() || !node.isNode()) return;
    // Not skipped when the node is already selected: the same tile can be
    // arrived at twice by different routes, and the second arrival still has a
    // different route to draw.
    cy.nodes().unselect();
    node.select();
    applyHighlight(cy, node as NodeSingular);
  }, [selectedId, highlightChain, keepLit, ghost, cyEpoch, ready, nodes, applyHighlight]);



  return <div ref={containerRef} className="h-full w-full bg-slate-950" />;
}
