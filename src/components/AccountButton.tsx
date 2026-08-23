'use client';

/**
 * The signed-in account, top right: change your own password, or sign out.
 *
 * Changing a password invalidates every session that account has open, which is
 * the point — if the reason for changing it is that someone else saw it, the
 * other browser has to stop working. Everyone else is unaffected.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MIN_PASSWORD } from '@/lib/gate.client';

const field = `w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm
               text-slate-100 placeholder:text-slate-600 focus:border-indigo-500
               focus:outline-none`;

export default function AccountButton() {
  const [email, setEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/gate')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (live && body?.email) setEmail(body.email as string);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
    setDone(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    firstField.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

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
        setError(body?.error ?? 'Could not change your password.');
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

  async function signOut() {
    await fetch('/api/gate', { method: 'DELETE' }).catch(() => {});
    window.location.href = '/gate';
  }

  // The address is the useful part; the domain is the same for everyone here.
  const label = email ? email.split('@')[0] : 'Account';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={email ? `Signed in as ${email}` : 'Account'}
        className="max-w-28 truncate rounded border border-slate-700 px-2 py-1
                   hover:bg-slate-800"
      >
        {label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Account"
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-24"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="truncate text-sm font-semibold text-slate-100">
                {email ?? 'Account'}
              </h2>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="shrink-0 text-slate-500 hover:text-slate-300"
              >
                ✕
              </button>
            </div>

            {done ? (
              <div className="mt-3 space-y-3">
                <p className="text-sm text-emerald-400">Password changed.</p>
                <p className="text-xs leading-relaxed text-slate-400">
                  Any other device signed in as you has been signed out. This tab is still
                  signed in.
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
              <>
                <form onSubmit={submit} className="mt-3 space-y-2">
                  <input
                    ref={firstField}
                    type="password"
                    autoComplete="current-password"
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                    placeholder="Current password"
                    aria-label="Current password"
                    className={field}
                  />
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                    placeholder={`New password (${MIN_PASSWORD}+ characters)`}
                    aria-label="New password"
                    className={field}
                  />
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Repeat new password"
                    aria-label="Repeat new password"
                    className={field}
                  />
                  {error && <p className="text-sm text-rose-400">{error}</p>}
                  <button
                    type="submit"
                    disabled={busy || !current || next.length < MIN_PASSWORD || !confirm}
                    className="w-full rounded bg-indigo-600 px-3 py-2 text-sm font-medium
                               text-white hover:bg-indigo-500 disabled:opacity-40"
                  >
                    {busy ? 'Changing…' : 'Change password'}
                  </button>
                </form>

                <button
                  type="button"
                  onClick={signOut}
                  className="mt-3 w-full rounded border border-slate-700 px-3 py-2 text-sm
                             text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                >
                  Sign out
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
