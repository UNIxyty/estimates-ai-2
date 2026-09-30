'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/client';
import { passwordProblem, PASSWORD_MIN_LENGTH } from '@/lib/passwordRules';

type State = 'loading' | 'valid' | 'expired' | 'used' | 'invalid';

export function SetPasswordForm() {
  const token = useSearchParams().get('token') || '';
  const [state, setState] = useState<State>('loading');
  const [kind, setKind] = useState<'invite' | 'reset' | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setState('invalid');
      return;
    }
    api<{ state: State; kind: 'invite' | 'reset' | null; email: string | null }>(`/api/auth/token?token=${encodeURIComponent(token)}`)
      .then((r) => {
        setState(r.state);
        setKind(r.kind);
        setEmail(r.email);
      })
      .catch(() => setState('invalid'));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(pw);
    if (problem) return setError(problem);
    if (pw !== pw2) return setError('Passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/set-password', { method: 'POST', json: { token, password: pw } });
      window.location.href = '/chat';
    } catch (err) {
      const b = err instanceof ApiError ? err.body : {};
      if (b.state === 'expired' || b.state === 'used' || b.state === 'invalid') setState(b.state as State);
      else setError(String(b.message || 'Could not set the password.'));
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading') return <p>Checking link…</p>;
  if (state === 'expired')
    return (
      <p role="alert">
        This link has expired. {kind === 'reset' ? <>Request a new one on the <Link href="/login">sign-in page</Link>.</> : 'Ask an admin to resend your invite.'}
      </p>
    );
  if (state === 'used')
    return (
      <p role="alert">
        This link has already been used. <Link href="/login">Sign in</Link> or request a new reset link.
      </p>
    );
  if (state === 'invalid')
    return (
      <p role="alert">
        This link is not valid. <Link href="/login">Go to sign in</Link>.
      </p>
    );

  const problem = pw ? passwordProblem(pw) : null;
  return (
    <form onSubmit={submit}>
      <p>{kind === 'invite' ? 'Welcome! Choose a password to activate your account' : 'Choose a new password'} for <b>{email}</b>.</p>
      <p>Rules: at least {PASSWORD_MIN_LENGTH} characters and at least one number.</p>
      <p>
        <label>New password <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></label>
      </p>
      {problem && <p role="status">{problem}</p>}
      <p>
        <label>Repeat password <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></label>
      </p>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy || !!problem || !pw}>{busy ? 'Saving…' : 'Set password'}</button>
    </form>
  );
}
