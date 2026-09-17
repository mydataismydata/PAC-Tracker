'use client';

/**
 * A table on the methods page, with the rows behind it available as a file.
 *
 * Every table here is evidence for a claim made somewhere else on the site, so
 * two things matter more than they would on an ordinary listing. A reader has
 * to be able to take the rows away and check them against the filings
 * themselves, which is the export. And a table of sixteen hundred folds must
 * not bury the four-row table above it, which is the fold.
 *
 * Collapsed tables render no rows at all until they are opened, rather than
 * hiding them with CSS. Sixteen hundred rows of markup nobody asked to see is
 * a slower page for every reader, and the export works from the data rather
 * than from the DOM, so nothing is lost by leaving them out.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import PanelHeading from '@/components/kym/PanelHeading';

export interface Column {
  label: string;
  /** Right-aligned and tabular, for money and counts. */
  numeric?: boolean;
}

export type Cell =
  | string
  | { text: string; href?: string; muted?: boolean }
  /** Several names in one cell, each its own link. */
  | { parts: { text: string; href?: string }[]; empty?: string };

function isParts(cell: Cell): cell is { parts: { text: string; href?: string }[]; empty?: string } {
  return typeof cell !== 'string' && 'parts' in cell;
}

/** What this cell says, for the export and for anything measuring it. */
function text(cell: Cell): string {
  if (typeof cell === 'string') return cell;
  if (isParts(cell)) return cell.parts.length ? cell.parts.map((p) => p.text).join('; ') : (cell.empty ?? '');
  return cell.text;
}

/**
 * One field of a CSV row.
 *
 * Quoted whenever the value carries a comma, a quote or a newline, with inner
 * quotes doubled — which is the whole of RFC 4180 that a reader's spreadsheet
 * cares about. A leading `=`, `+`, `-` or `@` is prefixed with a quote as
 * well: without it a committee named "-Florida First" is read as a formula by
 * every spreadsheet that opens the file.
 */
function csvField(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function download(filename: string, columns: Column[], rows: Cell[][]): void {
  const lines = [
    columns.map((c) => csvField(c.label)).join(','),
    ...rows.map((r) => r.map((cell) => csvField(text(cell))).join(',')),
  ];
  // The byte order mark is what makes Excel read the file as UTF-8 rather than
  // as the host's code page, which otherwise mangles every name with an
  // accent or a curly apostrophe in it.
  const blob = new Blob(['﻿', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function DataTable({
  heading,
  tagline,
  columns,
  rows,
  filename,
  collapsible = false,
  footnote,
}: {
  heading: string;
  tagline?: React.ReactNode;
  columns: Column[];
  rows: Cell[][];
  /** Name the export lands under, without the extension. */
  filename: string;
  collapsible?: boolean;
  footnote?: React.ReactNode;
}) {
  const [open, setOpen] = useState(!collapsible);
  const count = rows.length;
  const body = useMemo(() => (collapsible && !open ? [] : rows), [collapsible, open, rows]);

  return (
    <section className="mt-10">
      <div className="flex items-start justify-between gap-4">
        <PanelHeading
          info={tagline}
          count={collapsible ? count : undefined}
          onToggle={collapsible ? () => setOpen((v) => !v) : undefined}
          expanded={collapsible ? open : undefined}
        >
          {heading}
        </PanelHeading>
        <button
          type="button"
          onClick={() => download(`${filename}.csv`, columns, rows)}
          className="shrink-0 rounded border border-slate-800 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-slate-500 hover:border-slate-700 hover:text-slate-300"
        >
          Export CSV
        </button>
      </div>

      {open && (
        <div className="mt-3 overflow-x-auto rounded border border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/60">
                {/* Keyed by position, not by label. A table may name two
                    columns the same thing — a fold has a source on each side
                    of it — and React drops one of two children sharing a key. */}
                {columns.map((c, i) => (
                  <th
                    key={i}
                    scope="col"
                    className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 ${
                      c.numeric ? 'text-right' : 'text-left'
                    }`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-900">
              {body.map((row, i) => (
                <tr key={i} className="hover:bg-slate-900/40">
                  {row.map((cell, j) => {
                    const c = columns[j];
                    const value = text(cell);
                    const muted = typeof cell !== 'string' && !isParts(cell) && cell.muted;
                    const href = typeof cell !== 'string' && !isParts(cell) ? cell.href : undefined;
                    return (
                      <td
                        key={j}
                        className={`px-3 py-2 align-top ${
                          c?.numeric
                            ? 'text-right font-mono tabular-nums text-slate-300'
                            : 'text-slate-300'
                        } ${muted ? 'text-slate-600' : ''}`}
                      >
                        {isParts(cell) ? (
                          cell.parts.length === 0 ? (
                            <span className="text-slate-600">{cell.empty ?? '—'}</span>
                          ) : (
                            cell.parts.map((p, k) => (
                              <span key={k}>
                                {k > 0 && <span className="text-slate-700">, </span>}
                                {p.href ? (
                                  <Link href={p.href} className="text-slate-200 hover:text-indigo-300">
                                    {p.text}
                                  </Link>
                                ) : (
                                  p.text
                                )}
                              </span>
                            ))
                          )
                        ) : href ? (
                          <Link href={href} className="text-slate-200 hover:text-indigo-300">
                            {value}
                          </Link>
                        ) : (
                          value
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {footnote && <p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-400">{footnote}</p>}
    </section>
  );
}
