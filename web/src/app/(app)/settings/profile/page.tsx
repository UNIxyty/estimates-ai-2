'use client';

/** design/settings-profile.dc.html, DESIGN.md §4.11. */
import { useEffect, useState, type CSSProperties } from 'react';
import { SettingsFrame } from '@/components/SettingsNav';
import { api, ApiError } from '@/lib/client';
import { passwordProblem, PASSWORD_MIN_LENGTH } from '@/lib/passwordRules';
import { setThemePref, themePref, type ThemePref } from '@/lib/theme';

interface Profile { email: string; name: string; send_estimates_to: string | null }

const panel: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, padding: 20, border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)' };
const label: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13.5, fontWeight: 500 };
const field: CSSProperties = { height: 42, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontWeight: 400, fontSize: 14.5, outlineColor: 'var(--acc)' };
const note: CSSProperties = { fontSize: 12.5, fontWeight: 400, color: 'var(--ink3)' };
const primary: CSSProperties = { height: 38, padding: '0 16px', border: 0, borderRadius: 10, background: 'var(--acc)', color: '#fff', font: 'inherit', fontWeight: 600, fontSize: 13.5, cursor: 'pointer' };
const secondary: CSSProperties = { height: 38, padding: '0 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 13.5, cursor: 'pointer' };

const THEMES: [ThemePref, string, string, string, string][] = [
  ['light', 'Light', '#f5f6f8', '#ffffff', '#e1e4e9'],
  ['dark', 'Dark', '#101214', '#1a1d21', '#2d3238'],
  ['system', 'Match my computer', 'linear-gradient(#f5f6f8 50%,#101214 50%)', 'linear-gradient(90deg,#ffffff 50%,#1a1d21 50%)', '#8a9099'],
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ProfilePage() {
  const [p, setP] = useState<Profile | null>(null);
  const [name, setName] = useState('');
  const [sendTo, setSendTo] = useState('');
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);
  const [theme, setTheme] = useState<ThemePref>('light');
  const [pwOpen, setPwOpen] = useState(false);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ profile: Profile }>('/api/profile').then((r) => {
      setP(r.profile);
      setName(r.profile.name ?? '');
      setSendTo(r.profile.send_estimates_to || r.profile.email);
    }).catch((e) => setError(e.message || 'Could not load your profile.'));
    setTheme(themePref());
    const f = () => setTheme(themePref());
    window.addEventListener('eaa:theme', f);
    return () => window.removeEventListener('eaa:theme', f);
  }, []);

  async function save() {
    if (!p) return;
    const to = sendTo.trim();
    if (to && !EMAIL.test(to)) return setSaved({ ok: false, text: 'Enter a full email address.' });
    try {
      const r = await api<{ profile: Profile }>('/api/profile', {
        method: 'PATCH',
        // Same as the sign-in email → store nothing, so it follows the account email.
        json: { name: name.trim(), send_estimates_to: !to || to.toLowerCase() === p.email.toLowerCase() ? '' : to },
      });
      setP(r.profile);
      setSendTo(r.profile.send_estimates_to || r.profile.email);
      setSaved({ ok: true, text: 'Saved' });
    } catch (e) {
      setSaved({ ok: false, text: e instanceof ApiError ? e.message : 'Could not save.' });
    }
  }

  async function changePassword() {
    const problem = passwordProblem(next);
    if (!cur) return setPwMsg({ ok: false, text: 'Enter your current password.' });
    if (problem) return setPwMsg({ ok: false, text: problem });
    setPwMsg(null);
    setBusy(true);
    try {
      await api('/api/profile/password', { method: 'POST', json: { current: cur, next } });
      setPwOpen(false);
      setCur('');
      setNext('');
      setPwMsg({ ok: true, text: 'Password updated. You were signed out everywhere else.' });
    } catch (e) {
      const b = e instanceof ApiError ? e.body : {};
      setPwMsg({ ok: false, text: b.error === 'wrong_password' ? 'The current password is wrong.' : String(b.message || b.error || 'Could not change the password.') });
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    window.location.href = '/login';
  }

  return (
    <SettingsFrame maxWidth={1000} contentMaxWidth={620}>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Profile</h1>
      {error && <span style={{ fontSize: 14, color: 'var(--err)' }}>{error}</span>}
      {!p && !error && <span style={{ fontSize: 14, color: 'var(--ink3)' }}>Loading…</span>}
      {p && (
        <div style={panel}>
          <label style={label}>Name
            <input value={name} onChange={(e) => { setName(e.target.value); setSaved(null); }} autoComplete="name" style={field} />
          </label>
          <label style={label}>Send estimates to
            <input type="email" value={sendTo} onChange={(e) => { setSendTo(e.target.value); setSaved(null); }} placeholder={p.email} style={field} />
            <span style={note}>When you say “send me this estimate”, the file goes here. Your sign-in email stays {p.email}.</span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="button" onClick={save} style={primary}>Save</button>
            {saved && <span role="status" style={{ fontSize: 13, color: saved.ok ? 'var(--ok)' : 'var(--err)' }}>{saved.text}</span>}
          </div>
        </div>
      )}

      <div style={{ ...panel, gap: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>Theme</span>
        <div role="radiogroup" aria-label="Theme" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 10 }}>
          {THEMES.map(([k, lbl, side, main, bar]) => {
            const on = theme === k;
            return (
              <button key={k} type="button" role="radio" aria-checked={on} onClick={() => { setThemePref(k); setTheme(k); }}
                style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, border: `1.5px solid ${on ? 'var(--acc)' : 'var(--line)'}`, borderRadius: 12, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 13.5, cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ height: 56, width: '100%', borderRadius: 8, display: 'flex', overflow: 'hidden', border: '1px solid var(--line)' }}>
                  <span style={{ width: '30%', background: side }} />
                  <span style={{ flex: 1, background: main, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: 8, gap: 4 }}>
                    <span style={{ height: 6, width: '60%', borderRadius: 3, background: bar }} />
                    <span style={{ height: 6, width: '40%', borderRadius: 3, background: '#1f5eff' }} />
                  </span>
                </span>
                <span style={{ fontWeight: on ? 600 : 400 }}>{lbl}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ ...panel, gap: 14 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>Password</span>
        {!pwOpen ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 180, fontSize: 13.5, color: pwMsg?.ok ? 'var(--ok)' : 'var(--ink2)' }}>
              {pwMsg?.ok ? pwMsg.text : 'Changing it signs you out on your other devices.'}
            </span>
            <button type="button" onClick={() => { setPwOpen(true); setPwMsg(null); }} className="hv-sunk"
              style={{ ...secondary, height: 36, borderRadius: 9 }}>Change password</button>
          </div>
        ) : (
          <form noValidate onSubmit={(e) => { e.preventDefault(); changePassword(); }} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <label style={label}>Current password
              <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" autoFocus style={field} />
            </label>
            <label style={label}>New password
              <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} style={field} />
              <span style={note}>At least {PASSWORD_MIN_LENGTH} characters, including a number.</span>
            </label>
            {pwMsg && !pwMsg.ok && <span role="alert" style={{ fontSize: 13, color: 'var(--err)' }}>{pwMsg.text}</span>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" disabled={busy} style={{ ...primary, opacity: busy ? 0.7 : 1 }}>Update password</button>
              <button type="button" onClick={() => { setPwOpen(false); setCur(''); setNext(''); setPwMsg(null); }} style={secondary}>Cancel</button>
            </div>
          </form>
        )}
      </div>

      <button type="button" onClick={signOut} className="hv-under"
        style={{ alignSelf: 'flex-start', border: 0, background: 'transparent', padding: 0, font: 'inherit', fontSize: 14, color: 'var(--err)', cursor: 'pointer' }}>Sign out</button>
    </SettingsFrame>
  );
}
