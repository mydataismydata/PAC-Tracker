/**
 * Which stretch of time a page's money covers.
 *
 * Every page about one subject's money opens on all of it, and a reader can
 * narrow it two ways. One is a session, which is an election cycle:
 * `?cycle=20261103-GEN` reads "2026 session". The other is a range of days:
 * `?from=2025-11-01&to=2026-01-01`, both ends included, and either end works
 * alone. A bill page on Know Your Legislation links in with both kinds.
 *
 * The headline figures, the lists, the per-filing amounts and the picture all
 * take the same period, so no figure on a page covers more than the others.
 */

import { CYCLES } from '@/lib/cycles';

export interface Period {
  cycle?: string;
  dateFrom?: string;
  dateTo?: string;
}

/** The query string as Next hands it to a page. */
export interface PeriodQuery {
  cycle?: string | string[];
  from?: string | string[];
  to?: string | string[];
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * A query-string date, or undefined when it is not a real day.
 *
 * Checked here rather than left to Postgres: a cast of 2026-02-30 fails the
 * query, and the reader gets an error page instead of the unfiltered one.
 */
export function day(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

/**
 * The period a URL asks for.
 *
 * A cycle the database does not know is dropped rather than queried, and a
 * range typed backwards is turned round: nobody means "from March to January".
 */
export function readPeriod(query: PeriodQuery): Period {
  const raw = first(query.cycle);
  const cycle = CYCLES.some((c) => c.id === raw) ? raw : undefined;
  let dateFrom = day(first(query.from));
  let dateTo = day(first(query.to));
  if (dateFrom && dateTo && dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
  return { cycle, dateFrom, dateTo };
}

export function isNarrowed(p: Period): boolean {
  return Boolean(p.cycle || p.dateFrom || p.dateTo);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2025-11-09` → `Nov 09 2025`. Read off the string, so no time zone can shift it. */
export function showDay(value: string): string {
  const [y, m, d] = value.split('-');
  return `${MONTHS[Number(m) - 1]} ${d} ${y}`;
}

/** `20261103-GEN` → `2026 session`. */
export function sessionLabel(cycle: string): string {
  return `${CYCLES.find((c) => c.id === cycle)?.label ?? cycle.slice(0, 4)} session`;
}

/** What a page says it is showing: "All dates", "2026 session", or the range. */
export function periodLabel(p: Period): string {
  const parts: string[] = [];
  if (p.cycle) parts.push(sessionLabel(p.cycle));
  if (p.dateFrom && p.dateTo) parts.push(`${showDay(p.dateFrom)} through ${showDay(p.dateTo)}`);
  else if (p.dateFrom) parts.push(`Since ${showDay(p.dateFrom)}`);
  else if (p.dateTo) parts.push(`Through ${showDay(p.dateTo)}`);
  return parts.join(', ') || 'All dates';
}

/** The period as query-string pairs, in the names the pages read. */
export function periodParams(p: Period): [string, string][] {
  const pairs: [string, string | undefined][] = [
    ['cycle', p.cycle],
    ['from', p.dateFrom],
    ['to', p.dateTo],
  ];
  return pairs.filter((pair): pair is [string, string] => Boolean(pair[1]));
}

/**
 * A link to another page that keeps the reader in the same period.
 *
 * A reader following 2024 money through a chain of committees should stay in
 * 2024, and one looking at the weeks around a bill should stay in those weeks.
 */
export function withPeriod(href: string, p?: Period): string {
  const query = p ? new URLSearchParams(periodParams(p)).toString() : '';
  return query ? `${href}${href.includes('?') ? '&' : '?'}${query}` : href;
}
