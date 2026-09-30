'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/client';

export function LoginForms() {
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  async function onLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/login', { method: 'POST', json: { email: f.get('email'), password: f.get('password') } });
      const next = params.get('next');
      window.location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/chat';
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(status === 429 ? 'Too many attempts. Try again in a few minutes.' : 'Email or password is incorrect.');
    } finally {
      setBusy(false);
    }
  }

  async function onForgot(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api('/api/auth/forgot', { method: 'POST', json: { email: f.get('email') } }).catch(() => {});
    setForgotSent(true);
  }

  return (
    <>
      <form onSubmit={onLogin}>
        <p>
          <label>Email <input name="email" type="email" autoComplete="username" required /></label>
        </p>
        <p>
          <label>Password <input name="password" type="password" autoComplete="current-password" required /></label>
        </p>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>

      <details>
        <summary>Forgot password?</summary>
        {forgotSent ? (
          <p role="status">If an active account exists for that email, a reset link is on its way. The link works for 1 hour.</p>
        ) : (
          <form onSubmit={onForgot}>
            <p>
              <label>Email <input name="email" type="email" required /></label>
            </p>
            <button type="submit">Send reset link</button>
          </form>
        )}
      </details>
    </>
  );
}
