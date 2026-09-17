'use client';

/**
 * A section heading with its explanation folded behind an `i`.
 *
 * The explanations on these pages are worth having and worth hiding. Each one
 * says what a column counts and what it deliberately leaves out, which is the
 * difference between a figure a reader can use and one they can only believe —
 * and a reader who already knows should not have to scroll past four of them
 * to reach the rows.
 *
 * So the heading reads at full contrast and the paragraph under it opens on
 * request. Both are the same weight of white when they are showing: an
 * explanation set in grey beside a table set in white reads as a disclaimer
 * nobody meant anyone to finish.
 */

import { useId, useState } from 'react';

export default function PanelHeading({
  children,
  info,
  count,
  onToggle,
  expanded,
}: {
  children: React.ReactNode;
  /** The explanation. Nothing is rendered, and no `i` offered, without one. */
  info?: React.ReactNode;
  /** Shown beside the heading, for a list whose length is worth knowing. */
  count?: number;
  /** Set for a heading that also opens the section itself. */
  onToggle?: () => void;
  expanded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  const heading = (
    <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-100">{children}</h2>
  );

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="flex items-center gap-2 text-left text-slate-300 hover:text-indigo-300"
          >
            <svg
              viewBox="0 0 12 12"
              aria-hidden="true"
              className={`h-3 w-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            >
              <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            {heading}
            {count !== undefined && (
              <span className="font-mono text-[11px] tabular-nums text-slate-500">
                {count.toLocaleString()}
              </span>
            )}
          </button>
        ) : (
          <>
            {heading}
            {count !== undefined && (
              <span className="font-mono text-[11px] tabular-nums text-slate-500">
                {count.toLocaleString()}
              </span>
            )}
          </>
        )}

        {info && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={id}
            aria-label={open ? 'Hide what this counts' : 'What does this count?'}
            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border
                        font-serif text-[10px] italic leading-none transition-colors ${
                          open
                            ? 'border-indigo-400 text-indigo-300'
                            : 'border-slate-600 text-slate-400 hover:border-indigo-400 hover:text-indigo-300'
                        }`}
          >
            i
          </button>
        )}
      </div>

      {info && open && (
        <p id={id} className="mt-1.5 max-w-3xl text-xs leading-relaxed text-slate-100">
          {info}
        </p>
      )}
    </div>
  );
}
