'use client';

import { useEffect, useRef, useState } from 'react';
import type { AffiliationResult } from '@/lib/graph/affiliations';

export type { AffiliationResult, AffiliationCluster, AffiliationPeer } from '@/lib/graph/affiliations';

/**
 * Fetch the registration and shared-operative picture for one entity.
 *
 * Fetched only when the tab is open, like the trace: it runs a handful of
 * cluster counts and is wasted work on a panel nobody has opened.
 */
export function useAffiliations(entityId: string | null, enabled: boolean) {
  const [result, setResult] = useState<AffiliationResult | null>(null);
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
        const res = await fetch(`/api/entities/${entityId}/affiliations`, {
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
  }, [entityId, enabled]);

  return { result, loading, error };
}
