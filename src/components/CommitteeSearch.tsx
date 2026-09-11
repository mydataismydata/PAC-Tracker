'use client';

/**
 * The committee picker on Know Your Mailer.
 *
 * Takes the name printed on a mailer's disclaimer and turns it into a report.
 * Unlike the graph explorer's picker this one navigates rather than reporting a
 * selection upward: there is no canvas here to seed, only a page to open.
 *
 * Where a name is shared — three separate committees file as "Florida Forward"
 * — the link pins the committee's id, because the reader has already answered
 * that question by picking a row out of the list. Where it is not, the link is
 * the bare slug, which is the URL worth sharing.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatMoney, kindLabel } from '@/lib/graph/types';
import { committeeHref, type CommitteeHit } from '@/lib/graph/committee';

export default function CommitteeSearch({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CommitteeHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  /**
   * The query the results in hand actually answer.
   *
   * Kept so that "nothing matches" is only ever said about the text on screen.
   * A plain boolean would go stale the moment someone types another letter,
   * and the box would claim no match for a search still in flight.
   */
  const [answered, setAnswered] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  /**
   * Choosing a result writes the committee's name into the box, which would
   * otherwise start a fresh search and reopen the list over a page that is
   * already on its way.
   */
  const skipNextSearch = useRef(false);

  const ready = query.trim().length >= 2;
  const visible = ready ? results : [];

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }
    if (!ready) return;
    const controller = new AbortController();
    // Debounced so a fast typist does not fire a query per keystroke.
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/kym/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        const json = await res.json();
        setResults(json.results ?? []);
        setActive(0);
        setOpen(true);
        setAnswered(query.trim());
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
  }, [query, ready]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const choose = (hit: CommitteeHit) => {
    skipNextSearch.current = true;
    setQuery(hit.name);
    setOpen(false);
    router.push(committeeHref(hit));
  };

  return (
    <div ref={boxRef} className="relative">
      <label htmlFor="kym-search" className="sr-only">
        Search committees
      </label>
      <input
        id="kym-search"
        type="search"
        autoFocus={autoFocus}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && visible.length > 0}
        aria-controls="kym-search-results"
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
        placeholder="Search committees — type the name on the mailer"
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-4 py-3 text-base
                   text-slate-100 placeholder-slate-500 outline-none
                   focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
      />
      {loading && (
        <div
          className="absolute right-4 top-3.5 h-5 w-5 animate-spin rounded-full
                     border-2 border-slate-600 border-t-indigo-400"
        />
      )}

      {open && visible.length > 0 && (
        <ul
          id="kym-search-results"
          role="listbox"
          className="absolute z-30 mt-1 max-h-96 w-full overflow-auto rounded-md border
                     border-slate-700 bg-slate-900 shadow-xl"
        >
          {visible.map((r, i) => (
            <li key={r.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r)}
                className={`flex w-full items-start justify-between gap-3 px-3 py-2 text-left
                            ${i === active ? 'bg-slate-800' : 'hover:bg-slate-800/60'}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-100">{r.name}</span>
                  <span className="block truncate text-xs text-slate-400">
                    {kindLabel({ kind: r.kind, committeeType: r.committeeType })}
                    {r.city ? ` · ${r.city}, ${r.stateCode ?? ''}` : ''}
                    {r.status === 'closed' ? ' · closed' : ''}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs tabular-nums">
                  <span className="block text-emerald-400">{formatMoney(r.totalReceived)} in</span>
                  <span className="block text-amber-400">{formatMoney(r.totalGiven)} out</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Said out loud rather than left as an empty box, which reads as broken. */}
      {!loading && answered === query.trim() && visible.length === 0 && (
        <p className="mt-2 text-sm text-slate-500">
          No committee on file matches that. Try fewer words from the name.
        </p>
      )}
    </div>
  );
}
