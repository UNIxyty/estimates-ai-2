'use client';

import { useCallback, useEffect, useState } from 'react';
import { DesignPending } from '@/components/DesignPending';
import { useUser } from '@/components/UserContext';
import { api, ApiError, when } from '@/lib/client';

export default function UsersPage() {
  const me = useUser();
  const [users, setUsers] = useState<any[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ users: any[] }>('/api/users').then((r) => setUsers(r.users)).catch((e: ApiError) => setMsg(e.status === 403 ? 'Admins only.' : e.message));
  }, []);
  useEffect(load, [load]);

  async function run(fn: () => Promise<any>, ok: string) {
    setMsg(null);
    try {
      const r = await fn();
      setMsg(ok);
      if (r?.invite_url) setInviteUrl(r.invite_url);
      load();
    } catch (e) {
      const b = e instanceof ApiError ? e.body : {};
      setMsg(String(b.message || b.error || (e as Error).message));
    }
  }

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    await run(() => api('/api/users/invite', { method: 'POST', json: { email: f.get('email'), name: f.get('name'), role: f.get('role') } }), 'Invite sent.');
    form.reset();
  }

  if (me.role !== 'admin') return <section><DesignPending /><h1>Users</h1><p>Admins only.</p></section>;
  return (
    <section>
      <DesignPending />
      <h1>Users</h1>
      <form onSubmit={invite}>
        <fieldset>
          <legend>Invite a user</legend>
          <label>Email <input name="email" type="email" required /></label>{' '}
          <label>Name <input name="name" /></label>{' '}
          <label>Role <select name="role" defaultValue="estimator"><option value="estimator">Estimator</option><option value="admin">Admin</option></select></label>{' '}
          <button type="submit">Send invite</button>
        </fieldset>
      </form>
      {msg && <p role="status">{msg}</p>}
      {inviteUrl && <p>Invite link (valid 7 days, also emailed): <code>{inviteUrl}</code></p>}
      {!users ? (
        <p>Loading…</p>
      ) : (
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last active</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>
                  <select value={u.role} onChange={(e) => run(() => api(`/api/users/${u.id}`, { method: 'PATCH', json: { role: e.target.value } }), 'Role updated.')}>
                    <option value="estimator">estimator</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td>{u.status}{u.status === 'invited' && u.invite_expires_at && <> (invite expires {when(u.invite_expires_at)})</>}</td>
                <td>{when(u.last_active_at)}</td>
                <td>
                  {u.status === 'invited' && <button type="button" onClick={() => run(() => api(`/api/users/${u.id}/resend-invite`, { method: 'POST' }), 'Invite re-sent.')}>Resend invite</button>}{' '}
                  {u.status === 'active' && u.id !== me.id && <button type="button" onClick={() => confirm(`Disable ${u.email}?`) && run(() => api(`/api/users/${u.id}`, { method: 'DELETE' }), 'User disabled.')}>Disable</button>}{' '}
                  {u.status === 'disabled' && <button type="button" onClick={() => run(() => api(`/api/users/${u.id}`, { method: 'PATCH', json: { status: 'active' } }), 'User re-enabled.')}>Enable</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
