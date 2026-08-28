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
 * Fetch a funding trace for one entity.
 *
 * Deliberately not fetched alongside the ledger: a trace walks the whole
 * upstream subgraph and costs orders of magnitude more than a page of rows, so
 * it runs only when the tab is actually opened.
 */
export function useTrace(entityId: string | null, query: TraceQuery, enabled: boolean) {
  const [result, setResult] = useState<TraceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!entityId || !enabled) return;

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
        setResult(await res.json());
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
