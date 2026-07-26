'use client';

/**
 * Save and reload named crawls.
 *
 * The current tile layout is captured alongside the parameters, so reopening a
 * saved search restores the arrangement the user built rather than re-running
 * the force layout into a different shape.
 */

import { useCallback, useEffect, useState } from 'react';
import type { CrawlSettings } from '@/lib/graph/types';

export interface SavedSearchRow {
  id: string;
  name: string;
  description: string | null;
  seedEntityId: string;
  seedName: string | null;
  seedKind: string | null;
  params: unknown;
  nodePositions: unknown;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  currentSeedId: string | null;
  currentSeedName: string | null;
  settings: CrawlSettings;
  getPositions: () => Record<string, { x: number; y: number }>;
  onLoad: (search: SavedSearchRow) => void;
}

export default function SavedSearches({
  currentSeedId,
  currentSeedName,
  settings,
  getPositions,
  onLoad,
}: Props) {
  const [rows, setRows] = useState<SavedSearchRow[]>([]);
  /** null means "untouched", so the field can fall back to the seed's name. */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/searches');
      const json = await res.json();
      setRows(json.searches ?? []);
    } catch {
      /* listing is non-critical; leave the previous list in place */
    }
  }, []);

  // Load the list once. State is set from the fetch callback, and `cancelled`
  // stops a response that lands after unmount from writing to a dead component.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/searches')
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) setRows(json.searches ?? []);
      })
      .catch(() => {
        /* listing is non-critical */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Default the field to the seed's name so saving is a single click, without
   * syncing it through an effect: until the user types, the draft is null and
   * the seed name shows through. Changing seed therefore re-defaults for free.
   */
  const name = nameDraft ?? currentSeedName ?? '';

  const save = async () => {
    if (!currentSeedId || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          seedEntityId: currentSeedId,
          params: settings,
          nodePositions: getPositions(),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setNameDraft(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/searches/${id}`, { method: 'DELETE' });
    await refresh();
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <span className="block text-xs font-medium uppercase tracking-wide text-slate-400">
          Save current view
        </span>
        <input
          value={name}
          onChange={(e) => setNameDraft(e.target.value)}
          placeholder={currentSeedId ? 'Name this search…' : 'Pick a seed entity first'}
          disabled={!currentSeedId}
          className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm
                     text-slate-100 placeholder-slate-600 outline-none
                     focus:border-indigo-500 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={save}
          disabled={!currentSeedId || !name.trim() || busy}
          className="w-full rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white
                     hover:bg-indigo-500 disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save search + layout'}
        </button>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      <div>
        <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-400">
          Saved ({rows.length})
        </span>
        {rows.length === 0 ? (
          <p className="text-xs text-slate-600">Nothing saved yet.</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((r) => {
              const p = r.params as Partial<CrawlSettings> | null;
              return (
                <li
                  key={r.id}
                  className="group rounded border border-slate-800 bg-slate-900/50 p-2
                             hover:border-slate-700"
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onLoad(r)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate text-xs font-medium text-slate-200">
                        {r.name}
                      </span>
                      <span className="block truncate text-[11px] text-slate-500">
                        {r.seedName ?? 'unknown seed'}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-slate-600">
                        depth {p?.depth ?? '?'} · {p?.direction ?? '?'} · {p?.linkMode ?? '?'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(r.id)}
                      title="Delete"
                      className="shrink-0 rounded px-1 text-xs text-slate-600 opacity-0
                                 transition group-hover:opacity-100 hover:bg-red-950
                                 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
