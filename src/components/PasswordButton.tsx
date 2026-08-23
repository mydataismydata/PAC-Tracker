'use client';

/**
 * Change the shared site password from the header.
 *
 * Rotating it signs out every browser holding a session, which is the point:
 * the password is handed around, so changing it has to actually cut off whoever
 * had the old one. The tab that made the change keeps working.
 */

import { useEffect, useRef, useState } from 'react';
import { MIN_PASSPHRASE } from '@/lib/gate.client';

export default function PasswordButton() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    firstField.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function close() {
    setOpen(false);
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
    setDone(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/gate/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? 'Could not change the password.');
        setBusy(false);
        return;
      }
      setDone(true);
      setBusy(false);
    } catch {
      setError('Could not reach the server.');
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Change site password"
        className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800"
      >
        Password
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Change site password"
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-24"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Change site password</h2>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="text-slate-500 hover:text-slate-300"
              >
                ✕
              </button>
            </div>

            {done ? (
              <div className="mt-3 space-y-3">
                <p className="text-sm text-emerald-400">Password changed.</p>
                <p className="text-xs leading-relaxed text-slate-400">
                  Everyone signed in with the old password has been signed out, on every
                  device. This tab is still signed in.
                </p>
                <button
                  type="button"
                  onClick={close}
                  className="w-full rounded border border-slate-700 px-3 py-2 text-sm
                             hover:bg-slate-800"
                >
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={submit} className="mt-3 space-y-2">
                <input
                  ref={firstField}
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  placeholder="Current password"
                  aria-label="Current password"
                  className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2
                             text-sm text-slate-100 placeholder:text-slate-600
                             focus:border-indigo-500 focus:outline-none"
                />
                <input
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  placeholder={`New password (${MIN_PASSPHRASE}+ characters)`}
                  aria-label="New password"
                  className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2
                             text-sm text-slate-100 placeholder:text-slate-600
                             focus:border-indigo-500 focus:outline-none"
                />
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repeat new password"
                  aria-label="Repeat new password"
                  className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2
                             text-sm text-slate-100 placeholder:text-slate-600
                             focus:border-indigo-500 focus:outline-none"
                />
                {error && <p className="text-sm text-rose-400">{error}</p>}
                <button
                  type="submit"
                  disabled={busy || !current || next.length < MIN_PASSPHRASE || !confirm}
                  className="w-full rounded bg-indigo-600 px-3 py-2 text-sm font-medium
                             text-white hover:bg-indigo-500 disabled:opacity-40"
                >
                  {busy ? 'Changing…' : 'Change password'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
