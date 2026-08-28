'use client';

/**
 * Ask for an account, for someone who has landed here without one.
 *
 * Collapsed to a link until asked for, because the overwhelming majority of
 * people who reach this page have an account and are here to type a password.
 * Sends the ask to whoever runs the instance; it issues nothing itself.
 */

import { useState } from 'react';

const field = `w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-base
               text-slate-100 placeholder:text-slate-600 focus:border-indigo-500
               focus:outline-none`;

export default function RequestAccessForm() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/gate/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, note }),
      });
      const parsed = await res.json().catch(() => null);
      if (!res.ok) {
        setError((parsed?.error as string) ?? 'Something went wrong.');
        return;
      }
      setSent(true);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <p className="mt-6 border-t border-slate-800 pt-4 text-xs leading-relaxed text-emerald-400">
        Sent. Accounts are issued by hand, so this goes to a person rather than
        a queue — expect a reply to {email} rather than an instant account.
      </p>
    );
  }

  if (!open) {
    return (
      <p className="mt-6 border-t border-slate-800 pt-4 text-xs text-slate-500">
        No account?{' '}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-indigo-400 underline underline-offset-2 hover:text-indigo-300"
        >
          Request one
        </button>
        .
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3 border-t border-slate-800 pt-4">
      <p className="text-xs leading-relaxed text-slate-500">
        Accounts are issued by hand. Say who you are and what you are looking
        into, and it goes to whoever runs this instance.
      </p>

      <input
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className={field}
      />

      <textarea
        rows={3}
        maxLength={1000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Who you are, and why you want in"
        className={`${field} resize-y`}
      />

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white
                     hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Send request'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-slate-500 hover:text-slate-300"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
