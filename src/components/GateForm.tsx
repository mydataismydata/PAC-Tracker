'use client';

import { useState } from 'react';
import { MIN_PASSWORD } from '@/lib/gate.client';

const field = `w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-base
               text-slate-100 placeholder:text-slate-600 focus:border-indigo-500
               focus:outline-none`;

export default function GateForm({ mode, next }: { mode: 'signin' | 'change'; next: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A full navigation, not a router push: the middleware has to see the new
  // cookie, and the page behind the gate was never rendered.
  const leave = () => {
    window.location.href = next;
  };

  async function send(url: string, body: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const parsed = await res.json().catch(() => null);
      if (!res.ok) {
        setError((parsed?.error as string) ?? 'Something went wrong.');
        setBusy(false);
        return null;
      }
      return parsed ?? {};
    } catch {
      setError('Could not reach the server.');
      setBusy(false);
      return null;
    }
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    const result = await send('/api/gate', { email, password });
    if (!result) return;
    // A temporary password gets you exactly as far as the page that replaces it.
    window.location.href = result.mustChangePassword ? '/gate?change=1' : next;
  }

  async function change(e: React.FormEvent) {
    e.preventDefault();
    if (nextPassword !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    const result = await send('/api/gate/password', {
      current: password,
      next: nextPassword,
    });
    if (result) leave();
  }

  if (mode === 'change') {
    return (
      <form onSubmit={change} className="mt-6 space-y-3">
        <input
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Temporary password"
          aria-label="Temporary password"
          className={field}
        />
        <input
          type="password"
          autoComplete="new-password"
          value={nextPassword}
          onChange={(e) => setNextPassword(e.target.value)}
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
          disabled={busy || !password || nextPassword.length < MIN_PASSWORD || !confirm}
          className="w-full rounded bg-indigo-600 px-3 py-2 text-base font-medium text-white
                     hover:bg-indigo-500 disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Set my password'}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={signIn} className="mt-6 space-y-3">
      <input
        type="email"
        autoComplete="username"
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        aria-label="Email"
        className={field}
      />
      <input
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        aria-label="Password"
        className={field}
      />
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <button
        type="submit"
        disabled={busy || !email || !password}
        className="w-full rounded bg-indigo-600 px-3 py-2 text-base font-medium text-white
                   hover:bg-indigo-500 disabled:opacity-40"
      >
        {busy ? 'Checking…' : 'Sign in'}
      </button>
    </form>
  );
}
