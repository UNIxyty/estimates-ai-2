'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/client';
import { Spinner } from '@/components/ui';
import { AuthError, AuthFrame, AuthHeading, AuthMark, authBack, authInput, authLabel, authPrimary } from './AuthFrame';

type View = 'signin' | 'forgot' | 'sent';

const NOTE = "Access is by invitation only. If you don't have an account, ask your administrator to invite you.";
const MSG = {
  email: 'Enter the email address you were invited with.',
  password: 'Enter your password.',
  wrong: 'Email or password is incorrect. Check both and try again.',
  failed: 'Could not reach the server. Check your connection and try again.',
};

/** Only same-origin paths; never back to the sign-in page itself. */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/chat';
  if (next === '/login' || next.startsWith('/login?') || next.startsWith('/login/')) return '/chat';
  return next;
}

export function LoginForms() {
  const params = useSearchParams();
  const [view, setView] = useState<View>(params.has('forgot') ? 'forgot' : 'signin');
  const [email, setEmail] = useState(params.get('email') || '');
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState('');

  const go = (v: View) => {
    setView(v);
    setError('');
  };

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    const em = email.trim();
    if (!em.includes('@')) return setError(MSG.email);
    if (!pw) return setError(MSG.password);
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', { method: 'POST', json: { email: em, password: pw } });
      window.location.href = safeNext(params.get('next'));
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 401) setError(MSG.wrong);
      else if (status === 429) setError(String((err as ApiError).body.message || 'Too many attempts. Try again in a few minutes.'));
      else setError(MSG.failed);
      setBusy(false);
    }
  }

  async function onForgot(e: React.FormEvent) {
    e.preventDefault();
    const em = email.trim();
    if (!em.includes('@')) return setError(MSG.email);
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/forgot', { method: 'POST', json: { email: em } });
      setSentTo(em);
      setView('sent');
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(status === 429 ? String((err as ApiError).body.message || 'Too many requests. Try again later.') : MSG.failed);
    } finally {
      setBusy(false);
    }
  }

  const emailField = (
    <label style={authLabel}>
      Email
      <input
        type="email"
        name="email"
        autoComplete="username"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setError('');
        }}
        placeholder="name@company.com"
        aria-invalid={error === MSG.email || undefined}
        style={authInput}
      />
    </label>
  );

  return (
    <AuthFrame note={NOTE}>
      {view === 'signin' && (
        <form onSubmit={onLogin} noValidate style={{ display: 'contents' }}>
          <AuthHeading title="Sign in" sub="Use the email your administrator invited." />
          {error && <AuthError>{error}</AuthError>}
          {emailField}
          <div style={authLabel}>
            <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label htmlFor="login-password">Password</label>
              <button type="button" onClick={() => go('forgot')} style={{ border: 0, padding: 0, background: 'transparent', color: 'var(--accInk)', font: 'inherit', fontWeight: 400, fontSize: 13, cursor: 'pointer' }} className="hv-acc">
                Forgot password?
              </button>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', height: 44, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)', padding: '0 4px 0 12px' }}>
              <input
                id="login-password"
                name="password"
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                value={pw}
                onChange={(e) => {
                  setPw(e.target.value);
                  setError('');
                }}
                aria-invalid={error === MSG.password || error === MSG.wrong || undefined}
                style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--ink)', font: 'inherit', fontWeight: 400, fontSize: 15 }}
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? 'Hide password' : 'Show password'}
                aria-pressed={show}
                className="hv-sunk"
                style={{ height: 34, padding: '0 10px', border: 0, borderRadius: 8, background: 'transparent', color: 'var(--ink2)', font: 'inherit', fontWeight: 400, fontSize: 13, cursor: 'pointer' }}
              >
                {show ? 'Hide' : 'Show'}
              </button>
            </span>
          </div>
          <button type="submit" disabled={busy} style={authPrimary()}>
            {busy && <Spinner size={14} color="#fff" />}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}

      {view === 'forgot' && (
        <form onSubmit={onForgot} noValidate style={{ display: 'contents' }}>
          <AuthHeading title="Reset your password" sub="We'll email you a link to choose a new password." />
          {error && <AuthError>{error}</AuthError>}
          {emailField}
          <button type="submit" disabled={busy} style={authPrimary()}>
            {busy && <Spinner size={14} color="#fff" />}
            Send reset link
          </button>
          <button type="button" onClick={() => go('signin')} style={authBack} className="hv-ink">
            ‹ Back to sign in
          </button>
        </form>
      )}

      {view === 'sent' && (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <AuthMark tone="ok">✓</AuthMark>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}>Check your email</h1>
          <div style={{ fontSize: 14, color: 'var(--ink2)', lineHeight: 1.55, overflowWrap: 'anywhere' }}>
            If <b style={{ fontWeight: 600, color: 'var(--ink)' }}>{sentTo}</b> has an account, a reset link is on its way. The link works for 1 hour.
          </div>
          <button type="button" onClick={() => go('signin')} style={{ ...authBack, padding: 0 }} className="hv-ink">
            ‹ Back to sign in
          </button>
        </div>
      )}
    </AuthFrame>
  );
}
