'use client';

import { useEffect, useState } from 'react';
import type { EntityOfficer, OfficerSubject } from '@/lib/graph/officers';
import { isOfficerNode, OFFICER_NODE_PREFIX } from '@/lib/graph/types';

export type { EntityOfficer, OfficerSubject } from '@/lib/graph/officers';

/**
 * The person behind an officer hub node, and what their committees hold.
 *
 * The hub carries no money of its own, so the header's totals have to come
 * from the union of the committees naming them. Returns null for anything that
 * is not a hub.
 */
export function useOfficerSubject(nodeId: string | null, cycle?: string) {
  const [subject, setSubject] = useState<OfficerSubject | null>(null);
  const isHub = nodeId !== null && isOfficerNode(nodeId);

  useEffect(() => {
    if (!nodeId || !isOfficerNode(nodeId)) return;
    const controller = new AbortController();
    (async () => {
      try {
        const key = encodeURIComponent(nodeId.slice(OFFICER_NODE_PREFIX.length));
        const p = cycle ? `?cycle=${encodeURIComponent(cycle)}` : '';
        const res = await fetch(`/api/officers/${key}${p}`, { signal: controller.signal });
        if (!res.ok) return;
        setSubject(await res.json());
      } catch {
        // Falls back to the hub's own (zero) totals rather than an error state.
      }
    })();
    return () => controller.abort();
  }, [nodeId, cycle]);

  return isHub ? subject : null;
}

/** Chair and treasurer for one committee, for the panel header. */
export function useOfficers(entityId: string | null) {
  const [officers, setOfficers] = useState<EntityOfficer[]>([]);

  useEffect(() => {
    if (!entityId) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/entities/${entityId}/officers`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        setOfficers((await res.json()).officers ?? []);
      } catch {
        // A missing officer line is not worth an error state in the header.
      }
    })();
    return () => controller.abort();
  }, [entityId]);

  // Derived rather than cleared in the effect: the panel is keyed on the
  // subject, so a stale list would otherwise flash under a new name.
  return entityId ? officers : [];
}
