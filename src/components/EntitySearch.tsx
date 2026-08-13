'use client';

/** Debounced entity picker used to choose the seed of a crawl. */

import { useEffect, useRef, useState } from 'react';
import { formatMoney, kindLabel, type EntitySearchHit } from '@/lib/graph/types';

interface Props {
  onSelect: (hit: EntitySearchHit) => void;
  placeholder?: string;
  /** Show totals for this cycle, so results match the tiles they become. */
  cycle?: string;
}

export default function EntitySearch({ onSelect, placeholder, cycle }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<EntitySearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  /**
   * Choosing a result writes the entity's name into the box, which would
   * otherwise trigger a fresh search and immediately reopen the dropdown over
   * the graph the user just asked for.
   */
  const skipNextSearch = useRef(false);

  // Derived, not stored: below the minimum query length there is nothing to
  // show, so there is no reason to round-trip that through state.
  const visible = query.trim().length >= 2 ? results : [];

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }
    if (query.trim().length < 2) return;
    const controller = new AbortController();
    // Debounce so a fast typist does not fire a query per keystroke.
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/entities/search?q=${encodeURIComponent(query)}&limit=15` +
            (cycle ? `&cycle=${encodeURIComponent(cycle)}` : ''),
          { signal: controller.signal },
        );
        const json = await res.json();
        setResults(json.results ?? []);
        setActive(0);
        setOpen(true);
      } catch {
        /* aborted or offline; the next keystroke retries */
      } finally {
        setLoading(false);
      }
    }, 220);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, cycle]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const choose = (hit: EntitySearchHit) => {
    skipNextSearch.current = true;
    onSelect(hit);
    setQuery(hit.name);
    setResults([]);
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => visible.length > 0 && setOpen(true)}
        onKeyDown={(e) => {
          if (!open || visible.length === 0) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, visible.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(visible[active]);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        placeholder={placeholder ?? 'Search committees, candidates, donors…'}
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm
                   text-slate-100 placeholder-slate-500 outline-none
                   focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
      />
      {loading && (
        <div className="absolute right-3 top-2.5 h-4 w-4 animate-spin rounded-full
                        border-2 border-slate-600 border-t-indigo-400" />
      )}

      {open && visible.length > 0 && (
        <ul
          className="absolute z-30 mt-1 max-h-80 w-full overflow-auto rounded-md border
                     border-slate-700 bg-slate-900 shadow-xl"
        >
          {visible.map((r, i) => (
            <li key={r.id}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r)}
                className={`flex w-full items-start justify-between gap-3 px-3 py-2 text-left
                            ${i === active ? 'bg-slate-800' : 'hover:bg-slate-800/60'}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-100">{r.name}</span>
                  <span className="block text-xs text-slate-400">
                    {kindLabel({ kind: r.kind, committeeType: r.committee_type })}
                    {r.city ? ` · ${r.city}, ${r.state_code ?? ''}` : ''}
                    {r.status === 'closed' ? ' · closed' : ''}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs">
                  <span className="block text-emerald-400">
                    {formatMoney(r.total_received)} in
                  </span>
                  <span className="block text-amber-400">{formatMoney(r.total_given)} out</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
