'use client';

/** Crawl controls: depth, direction, link mode and filters. */

import { CYCLES, CURRENT_CYCLE, PREVIOUS_CYCLE } from '@/lib/cycles';
import {
  withLinkMode,
  type CrawlSettings,
  type Direction,
  type LinkMode,
} from '@/lib/graph/types';


interface Props {
  settings: CrawlSettings;
  onChange: (next: CrawlSettings) => void;
  disabled?: boolean;
}

/**
 * Cycle choices.
 *
 * "All cycles" is offered but is not the default: with 2024 and 2026 both
 * loaded, an unfiltered graph quietly answers "who has ever funded this",
 * which is rarely the question being asked.
 */
const CYCLE_CHOICES: { value: string | undefined; label: string; hint: string }[] = [
  {
    value: CURRENT_CYCLE.id,
    label: `Current (${CURRENT_CYCLE.label})`,
    hint: `Only money filed for the ${CURRENT_CYCLE.label} election`,
  },
  {
    value: PREVIOUS_CYCLE.id,
    label: `Previous (${PREVIOUS_CYCLE.label})`,
    hint: `Only money filed for the ${PREVIOUS_CYCLE.label} election`,
  },
  { value: undefined, label: 'All', hint: 'Every cycle loaded, summed together' },
];

/** Anything reachable from the dropdown rather than the three shortcuts. */
const OTHER_CYCLES = CYCLES.filter(
  (c) => c.id !== CURRENT_CYCLE.id && c.id !== PREVIOUS_CYCLE.id,
);

const DIRECTIONS: { value: Direction; label: string; hint: string }[] = [
  { value: 'upstream', label: 'Up', hint: 'Who funded this entity' },
  { value: 'downstream', label: 'Down', hint: 'Where this entity sent money' },
  { value: 'both', label: 'Both', hint: 'Follow money in and out' },
];

const LINK_MODES: { value: LinkMode; label: string; hint: string }[] = [
  {
    value: 'direct',
    label: 'Direct links only',
    hint: 'Follow the committee-to-committee chain. Individual and corporate donors are left out, keeping the political money path readable.',
  },
  {
    value: 'donor',
    label: 'Include donor links',
    hint: 'Also pull in the donors feeding each committee reached — the full funding base, and a much larger graph.',
  },
  {
    value: 'registration',
    label: 'Registration links',
    hint: 'Hop on shared officers instead of money: every entity naming the same person — a chair or treasurer of a committee, or a registered agent or board member of a corporation. Reaches entities with no payment between them, then draws the money that does move inside the network. Dashed lines are paperwork, not payments.',
  },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </span>
      {children}
    </label>
  );
}

export default function ControlPanel({ settings, onChange, disabled }: Props) {
  const set = <K extends keyof CrawlSettings>(key: K, value: CrawlSettings[K]) =>
    onChange({ ...settings, [key]: value });

  // The retuned per-node cap is written into the visible field rather than
  // applied behind the scenes, so it can be seen and overridden.
  const setLinkMode = (mode: LinkMode) => onChange(withLinkMode(settings, mode));

  return (
    <div className="space-y-4">
      <Field label={`Depth — ${settings.depth} level${settings.depth > 1 ? 's' : ''}`}>
        <input
          type="range"
          min={1}
          max={6}
          value={settings.depth}
          disabled={disabled}
          onChange={(e) => set('depth', Number(e.target.value))}
          className="w-full accent-indigo-500"
        />
        <div className="flex justify-between text-[10px] text-slate-500">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <span key={n}>{n}</span>
          ))}
        </div>
      </Field>

      <Field label="Election cycle">
        <div className="grid grid-cols-3 gap-1">
          {CYCLE_CHOICES.map((c) => (
            <button
              key={c.label}
              type="button"
              title={c.hint}
              disabled={disabled}
              onClick={() => set('cycle', c.value)}
              className={`rounded px-2 py-1 text-[11px] font-medium transition ${
                settings.cycle === c.value
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
              } disabled:opacity-40`}
            >
              {c.label}
            </button>
          ))}
        </div>
        {/* County portals go back to 2000, so the two shortcuts cannot reach
            most of what may be loaded. */}
        <select
          value={
            settings.cycle && OTHER_CYCLES.some((c) => c.id === settings.cycle)
              ? settings.cycle
              : ''
          }
          disabled={disabled}
          onChange={(e) => set('cycle', e.target.value || CURRENT_CYCLE.id)}
          className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-1.5 py-1
                     text-[11px] text-slate-300 outline-none focus:border-indigo-500
                     disabled:opacity-40"
        >
          <option value="">Earlier cycle…</option>
          {OTHER_CYCLES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Direction">
        <div className="grid grid-cols-3 gap-1">
          {DIRECTIONS.map((d) => (
            <button
              key={d.value}
              type="button"
              title={d.hint}
              disabled={disabled}
              onClick={() => set('direction', d.value)}
              className={`rounded px-2 py-1.5 text-xs font-medium transition
                ${
                  settings.direction === d.value
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                } disabled:opacity-50`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Link mode">
        <div className="space-y-1">
          {LINK_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              disabled={disabled}
              onClick={() => setLinkMode(m.value)}
              className={`w-full rounded border px-2 py-2 text-left transition
                ${
                  settings.linkMode === m.value
                    ? 'border-indigo-500 bg-indigo-950/60'
                    : 'border-slate-700 bg-slate-900 hover:border-slate-600'
                } disabled:opacity-50`}
            >
              <span className="block text-xs font-medium text-slate-100">{m.label}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-slate-400">
                {m.hint}
              </span>
            </button>
          ))}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Min $ per edge">
          <input
            type="number"
            min={0}
            step={1000}
            value={settings.minAmount ?? ''}
            disabled={disabled}
            placeholder="any"
            onChange={(e) =>
              set('minAmount', e.target.value === '' ? undefined : Number(e.target.value))
            }
            className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5
                       text-sm text-slate-100 outline-none focus:border-indigo-500"
          />
        </Field>
        <Field label="Max per node">
          <input
            type="number"
            min={1}
            max={200}
            value={settings.maxPerNode}
            disabled={disabled}
            onChange={(e) => set('maxPerNode', Math.max(1, Number(e.target.value)))}
            className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5
                       text-sm text-slate-100 outline-none focus:border-indigo-500"
          />
        </Field>
      </div>

      {/* The date range lives beside the ledger in the inspector, next to the
          rows it is usually being read against. */}

      <Field label={`Node ceiling — ${settings.maxNodes}`}>

        <input
          type="range"
          min={50}
          max={3000}
          step={50}
          value={settings.maxNodes}
          disabled={disabled}
          onChange={(e) => set('maxNodes', Number(e.target.value))}
          className="w-full accent-indigo-500"
        />
      </Field>
    </div>
  );
}
