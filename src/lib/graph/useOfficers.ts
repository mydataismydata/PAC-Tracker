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

interface Held {
  id: string;
  officers: EntityOfficer[];
  address: string | null;
}

/**
 * Chair, treasurer and address for one committee, for the panel header.
 *
 * What came back is held together with the id it came back for, and returned
 * only when that id is still the one being asked about. An address is a single
 * line with nothing in it that says whose it is, so the previous subject's
 * would otherwise sit under a new name looking like an answer — and clearing
 * it in the effect instead would mean a second render for every selection.
 */
export function useOfficers(entityId: string | null): Omit<Held, 'id'> {
  const [held, setHeld] = useState<Held | null>(null);

  useEffect(() => {
    if (!entityId) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/entities/${entityId}/officers`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body = await res.json();
        setHeld({ id: entityId, officers: body.officers ?? [], address: body.address ?? null });
      } catch {
        // A missing officer line is not worth an error state in the header.
      }
    })();
    return () => controller.abort();
  }, [entityId]);

  return held && held.id === entityId
    ? { officers: held.officers, address: held.address }
    : { officers: [], address: null };
}

/** The corporate / Form 990 profile for an entity, or null when it has none. */
export function useOrgProfile(entityId: string | null) {
  const [profile, setProfile] = useState<import('@/lib/graph/orgProfile').OrgProfile | null>(null);

  useEffect(() => {
    setProfile(null);
    if (!entityId) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/entities/${entityId}/profile`, { signal: controller.signal });
        if (!res.ok) return;
        setProfile((await res.json()).profile ?? null);
      } catch {
        // A missing profile just means no org block; not an error state.
      }
    })();
    return () => controller.abort();
  }, [entityId]);

  return entityId ? profile : null;
}
