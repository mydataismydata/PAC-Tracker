'use client';

import { useEffect, useRef, useState } from 'react';
import type { TraceResult } from '@/lib/graph/trace';
import { subjectApiBase } from '@/lib/graph/types';

export type { TraceResult, TracedSource } from '@/lib/graph/trace';

export interface TraceQuery {
  depth: number;
  min: number;
  dateOrdered: boolean;
  cycle?: string;
  /** Inclusive bounds on the transaction date; the same ones the graph uses. */
  dateFrom?: string;
  dateTo?: string;
}

/**
 * A trace already computed this session, kept so returning to an entity does not
 * pay for it again.
 *
 * The panel remounts on every node switch (it is keyed by node id), which throws
 * away the hook's state — so a reader who traces one entity, opens a name it
 * turned up, then goes back would otherwise re-run the whole upstream walk. This
 * lives at module scope, outside any component, so it outlasts that remount.
 *
 * The key includes every filter that changes the answer, so a different cycle or
 * date window is a separate entry rather than a stale hit. The result is a pure
 * function of entity and filters over a dataset that does not change under the
 * reader, so a hit is never wrong for the session. A modest cap keeps a long
 * session from holding every trace ever opened; the oldest entry falls out first.
 */
const traceCache = new Map<string, TraceResult>();
const TRACE_CACHE_MAX = 50;

function cacheKey(entityId: string, q: TraceQuery): string {
  return [
    entityId,
    q.depth,
    q.min,
    q.dateOrdered,
    q.cycle ?? '',
    q.dateFrom ?? '',
    q.dateTo ?? '',
  ].join('|');
}

function remember(key: string, result: TraceResult): void {
  // Re-insert to mark it most-recent, then evict from the front (oldest) if over.
  traceCache.delete(key);
  traceCache.set(key, result);
  if (traceCache.size > TRACE_CACHE_MAX) {
    const oldest = traceCache.keys().next().value;
    if (oldest !== undefined) traceCache.delete(oldest);
  }
}

/**
 * Fetch a funding trace for one entity.
 *
 * Deliberately not fetched alongside the ledger: a trace walks the whole
 * upstream subgraph and costs orders of magnitude more than a page of rows, so
 * it runs only when the tab is actually opened — and only when its answer is not
 * already in `traceCache` from earlier in the session.
 */
export function useTrace(entityId: string | null, query: TraceQuery, enabled: boolean) {
  const key = entityId && enabled ? cacheKey(entityId, query) : null;
  // Seed synchronously from the cache so a return to an already-traced entity
  // paints the report on the first render, with no loading flash and no refetch.
  const [result, setResult] = useState<TraceResult | null>(() =>
    key ? (traceCache.get(key) ?? null) : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!entityId || !enabled) return;

    const k = cacheKey(entityId, query);
    const cached = traceCache.get(k);
    if (cached) {
      // A hit: adopt it and skip the walk entirely.
      setResult(cached);
      setError(null);
      setLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const p = new URLSearchParams({
          depth: String(query.depth),
          min: String(query.min),
          dateOrdered: String(query.dateOrdered),
        });
        if (query.cycle) p.set('cycle', query.cycle);
        if (query.dateFrom) p.set('dateFrom', query.dateFrom);
        if (query.dateTo) p.set('dateTo', query.dateTo);
        const res = await fetch(`${subjectApiBase(entityId)}/trace?${p}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as TraceResult;
        remember(k, data);
        setResult(data);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [
    entityId,
    enabled,
    query.depth,
    query.min,
    query.dateOrdered,
    query.cycle,
    query.dateFrom,
    query.dateTo,
  ]);

  return { result, loading, error };
}
