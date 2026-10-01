'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/client';
import { passwordChecklist, passwordProblem } from '@/lib/passwordRules';
import { Spinner } from '@/components/ui';
import { AuthError, AuthFrame, AuthHeading, AuthMark, authInput, authLabel, authPrimary } from '../login/AuthFrame';

type LinkState = 'loading' | 'valid' | 'expired' | 'used' | 'invalid';
type Kind = 'invite' | 'reset';
type TokenInfo = { state: Exclude<LinkState, 'loading'>; kind: Kind | null; email: string | null; inviter?: string | null };

export function SetPasswordForm() {
  const token = useSearchParams().get('token') || '';
  const [state, setState] = useState<LinkState>('loading');
  const [kind, setKind] = useState<Kind | null>(null);
  const [email, setEmail] = useState('');
  const [inviter, setInviter] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return setState('invalid');
    api<TokenInfo>(`/api/auth/token?token=${encodeURIComponent(token)}`)
      .then((r) => {
        setState(r.state);
        setKind(r.kind);
        setEmail(r.email || '');
        setInviter(r.inviter || null);
      })
      .catch(() => setState('invalid'));
  }, [token]);

  const rules = passwordChecklist(pw, pw2);
  const ready = rules.every((r) => r.ok) && !passwordProblem(pw);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/set-password', { method: 'POST', json: { token, password: pw } });
      // The server signs the user in (fresh session cookie) and ends every other session.
      window.location.href = '/chat';
    } catch (err) {
      const b = err instanceof ApiError ? err.body : {};
      if (b.state === 'expired' || b.state === 'used' || b.state === 'invalid') setState(b.state as LinkState);
      else setError(String(b.message || 'Could not save the password. Try again.'));
      setBusy(false);
    }
  }

  if (state === 'loading') {
    return (
      <AuthFrame cardMaxWidth={420}>
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: 'var(--ink2)' }}>
          <Spinner size={16} /> Checking your link…
        </div>
      </AuthFrame>
    );
  }

  if (state !== 'valid') {
    const reset = kind === 'reset';
    const copy = {
      expired: {
        title: 'This link has expired',
        body: 'Invite and reset links work for 7 days and 1 hour. Ask your administrator for a new invite, or request a new reset link.',
      },
      used: {
        title: 'This link has already been used',
        body: reset
          ? 'A new password was already saved with this reset link. Sign in with it, or request a new reset link.'
          : 'This invite was already used to set a password. Sign in with that password, or use “Forgot password?” on the sign-in page.',
      },
      invalid: {
        title: 'This link isn’t valid',
        body: 'It may have been copied incompletely, or the account is no longer active. Open the link from your most recent email, or ask your administrator for a new invite.',
      },
    }[state];
    return (
      <AuthFrame cardMaxWidth={420}>
        <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <AuthMark tone="warn">!</AuthMark>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>{copy.title}</h1>
          <div style={{ fontSize: 14, color: 'var(--ink2)', lineHeight: 1.55 }}>{copy.body}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px' }}>
            <Link href="/login" style={{ fontSize: 14, fontWeight: 500 }}>Go to sign in</Link>
            {reset && state !== 'invalid' && (
              <Link href={`/login?forgot=1${email ? `&email=${encodeURIComponent(email)}` : ''}`} style={{ fontSize: 14, fontWeight: 500 }}>
                Request a new reset link
              </Link>
            )}
          </div>
        </div>
      </AuthFrame>
    );
  }

  const isReset = kind === 'reset';
  const sub = isReset
    ? 'Your old password stops working once you save the new one.'
    : `${inviter ? `${inviter} invited you` : 'You were invited'} to MGS Estimates AI. Set a password to finish creating your account.`;
  const pwField = (label: string, value: string, set: (v: string) => void, id: string) => (
    <label style={authLabel} htmlFor={id}>
      {label}
      <input
        id={id}
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(e) => {
          set(e.target.value);
          setError('');
        }}
        style={authInput}
      />
    </label>
  );
  const tooLong = passwordProblem(pw) === 'Password is too long.';

  return (
    <AuthFrame cardMaxWidth={420}>
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <AuthHeading gap={6} title={isReset ? 'Choose a new password' : 'Welcome to MGS Estimates AI'} sub={sub} />
        <label style={authLabel}>
          Email
          <input
            value={email}
            name="email"
            autoComplete="username"
            readOnly
            aria-readonly
            tabIndex={-1}
            style={{ ...authInput, background: 'var(--sunk)', color: 'var(--ink2)', cursor: 'default', outline: 0 }}
          />
        </label>
        {pwField('New password', pw, setPw, 'sp-new')}
        {pwField('Repeat password', pw2, setPw2, 'sp-repeat')}
        <ul aria-label="Password rules" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13.5 }}>
          {rules.map((r) => (
            <li key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 8, color: r.ok ? 'var(--ok)' : 'var(--ink3)' }}>
              <span aria-hidden style={{ width: 16, height: 16, flex: 'none', borderRadius: '50%', border: `1.5px solid ${r.ok ? 'var(--ok)' : 'var(--ink3)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, background: r.ok ? 'var(--ok)' : 'transparent', color: r.ok ? '#fff' : 'transparent' }}>
                ✓
              </span>
              {r.label}
              <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{r.ok ? ' (met)' : ' (not met)'}</span>
            </li>
          ))}
        </ul>
        {tooLong && <AuthError>Password is too long.</AuthError>}
        {error && <AuthError>{error}</AuthError>}
        <button type="submit" disabled={!ready || busy} style={authPrimary(ready)}>
          {busy && <Spinner size={14} color="#fff" />}
          {isReset ? 'Save and sign in' : 'Set password and continue'}
        </button>
      </form>
    </AuthFrame>
  );
}
