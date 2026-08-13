'use client';

/**
 * Consumes the SSE crawl stream into React state.
 *
 * Levels arrive incrementally, so the graph is renderable from the first event
 * and keeps growing while deeper levels are still being fetched. Starting a new
 * crawl aborts the previous one rather than letting two streams interleave.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CrawlSettings, GraphEdge, GraphNode } from './types';

export interface CrawlState {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  loading: boolean;
  /** Deepest level received so far. */
  levelsDone: number;
  truncated: boolean;
  error: string | null;
  elapsedMs: number | null;
}

const emptyState: CrawlState = {
  nodes: new Map(),
  edges: new Map(),
  loading: false,
  levelsDone: 0,
  truncated: false,
  error: null,
  elapsedMs: null,
};

export function useCrawl() {
  const [state, setState] = useState<CrawlState>(emptyState);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(emptyState);
  }, []);

  const start = useCallback((seedId: string, settings: CrawlSettings) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...emptyState, nodes: new Map(), edges: new Map(), loading: true });

    const qs = new URLSearchParams({
      seed: seedId,
      depth: String(settings.depth),
      direction: settings.direction,
      linkMode: settings.linkMode,
      maxPerNode: String(settings.maxPerNode),
      maxNodes: String(settings.maxNodes),
    });
    if (settings.minAmount != null) qs.set('minAmount', String(settings.minAmount));
    if (settings.dateFrom) qs.set('dateFrom', settings.dateFrom);
    if (settings.dateTo) qs.set('dateTo', settings.dateTo);
    if (settings.cycle) qs.set('cycle', settings.cycle);

    // fetch + manual SSE parsing rather than EventSource, because EventSource
    // cannot be aborted cleanly and offers no way to surface HTTP errors.
    (async () => {
      try {
        const res = await fetch(`/api/graph/stream?${qs}`, { signal: controller.signal });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => '');
          throw new Error(`stream failed (${res.status}) ${detail.slice(0, 200)}`);
        }

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;

          // SSE frames are separated by a blank line.
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!eventLine || !dataLine) continue;

            const event = eventLine.slice(7).trim();
            const payload = JSON.parse(dataLine.slice(6));

            if (event === 'level') {
              setState((prev) => {
                const nodes = new Map(prev.nodes);
                const edges = new Map(prev.edges);
                for (const n of payload.nodes as GraphNode[]) nodes.set(n.id, n);
                for (const e of payload.edges as GraphEdge[]) edges.set(e.id, e);
                return {
                  ...prev,
                  nodes,
                  edges,
                  levelsDone: Math.max(prev.levelsDone, payload.level),
                  truncated: prev.truncated || payload.truncated,
                };
              });
            } else if (event === 'done') {
              setState((prev) => ({ ...prev, loading: false, elapsedMs: payload.elapsedMs }));
            } else if (event === 'error') {
              setState((prev) => ({ ...prev, loading: false, error: payload.message }));
            }
          }
        }
        setState((prev) => (prev.loading ? { ...prev, loading: false } : prev));
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setState((prev) => ({ ...prev, loading: false, error: (err as Error).message }));
      }
    })();
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { ...state, start, reset };
}
