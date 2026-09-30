'use client';

import { useEffect, useState } from 'react';
import { DesignPending } from '@/components/DesignPending';
import { api, ApiError } from '@/lib/client';
import { passwordProblem, PASSWORD_MIN_LENGTH } from '@/lib/passwordRules';

export default function ProfilePage() {
  const [p, setP] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  useEffect(() => {
    api<{ profile: any }>('/api/profile').then((r) => setP(r.profile));
  }, []);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const r = await api<{ profile: any }>('/api/profile', {
        method: 'PATCH',
        json: { name: f.get('name'), send_estimates_to: String(f.get('send_estimates_to') || '') },
      });
      setP(r.profile);
      setMsg('Saved.');
    } catch (err) {
      setMsg(err instanceof ApiError ? `Error: ${err.message}` : 'Error');
    }
  }

  async function changePw(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const next = String(f.get('next') || '');
    const problem = passwordProblem(next);
    if (problem) return setPwMsg(problem);
    if (next !== f.get('next2')) return setPwMsg('Passwords do not match.');
    try {
      await api('/api/profile/password', { method: 'POST', json: { current: f.get('current'), next } });
      setPwMsg('Password changed. Other sessions were signed out.');
      form.reset();
    } catch (err) {
      const b = err instanceof ApiError ? err.body : {};
      setPwMsg(b.error === 'wrong_password' ? 'Current password is wrong.' : String(b.message || b.error || 'Error'));
    }
  }

  if (!p) return <p>Loading…</p>;
  return (
    <section>
      <DesignPending />
      <h1>Profile</h1>
      <form onSubmit={save}>
        <p>Email: {p.email} · Role: {p.role}</p>
        <p><label>Name <input name="name" defaultValue={p.name} /></label></p>
        <p>
          <label>Send estimates to <input name="send_estimates_to" type="email" defaultValue={p.send_estimates_to || ''} placeholder={p.email} /></label>
          <small> (empty = your account email)</small>
        </p>
        <button type="submit">Save</button> {msg && <span role="status">{msg}</span>}
      </form>

      <h2>Change password</h2>
      <form onSubmit={changePw}>
        <p><label>Current password <input name="current" type="password" autoComplete="current-password" required /></label></p>
        <p><label>New password <input name="next" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} /></label></p>
        <p><label>Repeat new password <input name="next2" type="password" autoComplete="new-password" required /></label></p>
        <p><small>At least {PASSWORD_MIN_LENGTH} characters and at least one number.</small></p>
        <button type="submit">Change password</button> {pwMsg && <span role="status">{pwMsg}</span>}
      </form>
    </section>
  );
}
