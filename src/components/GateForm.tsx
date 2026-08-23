'use client';

import { useState } from 'react';

export default function GateForm({ next }: { next: string }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? 'Could not sign in.');
        setBusy(false);
        return;
      }
      // A full navigation, not a router push: the middleware has to see the
      // new cookie, and the page behind the gate was never rendered.
      window.location.href = next;
    } catch {
      setError('Could not reach the server.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3">
      <input
        type="password"
        name="password"
        autoComplete="current-password"
        autoFocus
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="Password"
        aria-label="Site password"
        className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-base
                   text-slate-100 placeholder:text-slate-600 focus:border-indigo-500
                   focus:outline-none"
      />
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <button
        type="submit"
        disabled={busy || passphrase.length === 0}
        className="w-full rounded bg-indigo-600 px-3 py-2 text-base font-medium text-white
                   hover:bg-indigo-500 disabled:opacity-40"
      >
        {busy ? 'Checking…' : 'Enter'}
      </button>
    </form>
  );
}
