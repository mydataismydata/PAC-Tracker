'use client';

/**
 * Paginated ledger for the selected entity.
 *
 * Deliberately reads from the database rather than from the crawl result: the
 * graph shows a capped, filtered slice, but the panel has to be able to account
 * for every dollar in the tile's headline totals.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { subjectApiBase } from '@/lib/graph/types';

export type LedgerView = 'sources' | 'transactions';
export type LedgerDirection = 'in' | 'out' | 'all';
export type LedgerSort = 'amount' | 'date' | 'name' | 'count';

export interface LedgerSourceRow {
  entity_id: string;
  name: string;
  kind: string;
  committee_type: string | null;
  amount: string;
  txn_count: number;
  first_date: string | null;
  last_date: string | null;
  flow: 'in' | 'out';
  is_self: boolean;
}

export interface LedgerTransactionRow {
  id: string;
  counterparty_id: string | null;
  counterparty_name: string;
  amount: string;
  txn_date: string | null;
  flow: 'in' | 'out';
  txn_type_code: string | null;
  description: string | null;
  /** Contributor's street address as reported; recipients have none. */
  address: string | null;
  city: string | null;
  state_code: string | null;
  zip: string | null;
  occupation: string | null;
  source_key: string | null;
}

export type LedgerRow = LedgerSourceRow | LedgerTransactionRow;

export function isSourceRow(r: LedgerRow): r is LedgerSourceRow {
  return 'entity_id' in r;
}

const PAGE = 100;

export interface LedgerQuery {
  view: LedgerView;
  direction: LedgerDirection;
  q: string;
  sort: LedgerSort;
  /** Undefined means every cycle. */
  cycle?: string;
}

export function useLedger(entityId: string | null, query: LedgerQuery) {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalAmount, setTotalAmount] = useState('0');
  /** Of totalAmount, how much moved between committees in the subject set. */
  const [internalAmount, setInternalAmount] = useState('0');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const build = useCallback(
    (offset: number) => {
      const p = new URLSearchParams({
        view: query.view,
        direction: query.direction,
        sort: query.sort,
        limit: String(PAGE),
        offset: String(offset),
      });
      if (query.q.trim()) p.set('q', query.q.trim());
      if (query.cycle) p.set('cycle', query.cycle);
      return p;
    },
    [query.view, query.direction, query.sort, query.q, query.cycle],
  );

  /**
   * Fetch the first page whenever a query option changes.
   *
   * Switching entity is handled by remounting the panel (it is keyed on the
   * entity id), so this never has to reset state for a new subject — which
   * also keeps the previous entity's rows from flashing before the new ones
   * arrive.
   */
  useEffect(() => {
    if (!entityId) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Debounced so typing in the search box does not fire a query per keystroke.
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${subjectApiBase(entityId)}/ledger?${build(0)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setRows(json.rows ?? []);
        setTotal(json.total ?? 0);
        setTotalAmount(json.totalAmount ?? '0');
        setInternalAmount(json.internalAmount ?? '0');
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    }, query.q ? 220 : 0);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [entityId, build, query.q]);

  const loadMore = useCallback(async () => {
    if (!entityId || loading || rows.length >= total) return;
    setLoading(true);
    try {
      const res = await fetch(`${subjectApiBase(entityId)}/ledger?${build(rows.length)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setRows((prev) => [...prev, ...(json.rows ?? [])]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [entityId, loading, rows.length, total, build]);

  /**
   * Fetch every row, bypassing pagination, for CSV export. Capped high enough
   * to cover any real filer while still refusing to page forever.
   */
  const fetchAll = useCallback(async (): Promise<LedgerRow[]> => {
    if (!entityId) return [];
    const all: LedgerRow[] = [];
    for (let offset = 0; offset < 20_000; offset += 500) {
      const p = build(offset);
      p.set('limit', '500');
      p.set('offset', String(offset));
      const res = await fetch(`${subjectApiBase(entityId)}/ledger?${p}`);
      if (!res.ok) break;
      const json = await res.json();
      all.push(...(json.rows ?? []));
      if (all.length >= (json.total ?? 0) || (json.rows ?? []).length === 0) break;
    }
    return all;
  }, [entityId, build]);

  return {
    rows,
    total,
    totalAmount,
    loading,
    error,
    hasMore: rows.length < total,
    loadMore,
    internalAmount,
    fetchAll,
  };
}
