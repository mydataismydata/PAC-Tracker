'use client';

/**
 * The namer's button and its running list.
 *
 * The first name arrives already made, so the server and the browser agree on
 * what to render; every one after it is made here, because waiting on a round
 * trip would kill the joke. See `src/lib/kym/namer.ts` for how one is built.
 */

import { useState } from 'react';
import type { VocabularyWord } from '@/lib/graph/officers';
import { invent } from '@/lib/kym/namer';

export default function Namer({ pool, first }: { pool: VocabularyWord[]; first: string }) {
  const [name, setName] = useState(first);
  const [seen, setSeen] = useState<string[]>([]);

  const again = () => {
    setSeen((s) => [name, ...s].slice(0, 8));
    setName(invent(pool));
  };

  return (
    <div>
      <div className="rounded border border-indigo-900 bg-indigo-950/30 px-5 py-8 text-center">
        <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">
          Paid for by
        </p>
        <p
          aria-live="polite"
          className="mt-2 text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl"
          style={{ textWrap: 'balance' }}
        >
          {name}
        </p>
      </div>

      <button
        type="button"
        onClick={again}
        className="mt-3 rounded bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
      >
        Register another
      </button>

      {seen.length > 0 && (
        <div className="mt-6">
          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
            Also on file
          </p>
          <ul className="mt-2 divide-y divide-slate-900 rounded border border-slate-800">
            {seen.map((s, i) => (
              <li key={`${s}-${i}`} className="truncate px-4 py-2 text-sm text-slate-400">
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
