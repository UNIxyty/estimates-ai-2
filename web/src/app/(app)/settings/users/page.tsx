'use client';

/** design/settings-users.dc.html, DESIGN.md §4.12. Admin only; estimators get the no-access state. */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { SettingsFrame } from '@/components/SettingsNav';
import { useUser } from '@/components/UserContext';
import { initials, StatusBadge, type Tone } from '@/components/ui';
import { api, ApiError } from '@/lib/client';

interface U {
  id: string;
  email: string;
  name: string;
  role: 'estimator' | 'admin';
  status: 'invited' | 'active' | 'disabled';
  last_active_at: string | null;
  invite_expires_at: string | null;
}
type Shown = 'Active' | 'Invite sent' | 'Invite expired' | 'Removed';
const TONES: Record<Shown, Tone> = { Active: 'ok', 'Invite sent': 'acc', 'Invite expired': 'warn', Removed: 'mute' };
const COLS = 'minmax(220px,1fr) 140px 120px 110px 110px';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_HINT = 'They get an email with a link to set a password. The link works for 7 days.';
const ERRORS: Record<string, string> = {
  user_exists: 'That person already has an account.',
  user_disabled: 'That person was removed. Restore them from the list below.',
  last_admin: 'The last active admin cannot be changed to an estimator or removed.',
  cannot_disable_self: 'You cannot remove yourself.',
};
const errText = (e: unknown, fallback: string) => {
  const b = e instanceof ApiError ? e.body : {};
  return ERRORS[String(b.error)] ?? String(b.message || b.error || fallback);
};

function shownStatus(u: U): Shown {
  if (u.status === 'active') return 'Active';
  if (u.status === 'disabled') return 'Removed';
  return u.invite_expires_at && new Date(u.invite_expires_at).getTime() > Date.now() ? 'Invite sent' : 'Invite expired';
}
function lastActive(v: string | null) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  if (Date.now() - d.getTime() < 5 * 60 * 1000) return 'Now';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
const ctl: CSSProperties = { height: 40, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 14 };
const act = (fg: string, bg = 'transparent', fw = 400): CSSProperties => ({ height: 30, padding: '0 10px', border: 0, borderRadius: 7, background: bg, color: fg, font: 'inherit', fontSize: 12.5, fontWeight: fw, cursor: 'pointer', whiteSpace: 'nowrap' });

export default function UsersPage() {
  const me = useUser();
  const admin = me.role === 'admin';
  const [users, setUsers] = useState<U[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'estimator' | 'admin'>('estimator');
  const [inv, setInv] = useState<{ err: boolean; text: string }>({ err: false, text: INVITE_HINT });
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(() => {
    api<{ users: U[] }>('/api/users').then((r) => setUsers(r.users)).catch((e) => setError(e.message || 'Could not load users.'));
  }, []);
  useEffect(() => { if (admin) load(); }, [admin, load]);

  async function invite() {
    const e = email.trim().toLowerCase();
    if (!EMAIL.test(e)) return setInv({ err: true, text: 'Enter a full email address.' });
    setSending(true);
    try {
      await api('/api/users/invite', { method: 'POST', json: { email: e, role } });
      setEmail('');
      setInv({ err: false, text: `Invite sent to ${e}.` });
      load();
    } catch (x) {
      setInv({ err: true, text: errText(x, 'Could not send the invite.') });
    } finally {
      setSending(false);
    }
  }

  async function rowAction(u: U, fn: () => Promise<unknown>) {
    setRowMsg(null);
    try {
      await fn();
    } catch (x) {
      setRowMsg({ id: u.id, text: errText(x, 'That did not work.') });
    }
    setConfirm(null);
    load();
  }

  const setUserRole = (u: U, r: string) => rowAction(u, () => api(`/api/users/${u.id}`, { method: 'PATCH', json: { role: r } }));

  return (
    <SettingsFrame maxWidth={1080}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Users</h1>
        <span style={{ fontSize: 14, color: 'var(--ink2)' }}>Only admins see this page. The app is invite-only: people can&apos;t sign up on their own.</span>
      </div>

      {!admin ? (
        <div style={{ padding: 24, border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>You don&apos;t have access to this page</span>
          <span style={{ fontSize: 14, color: 'var(--ink2)' }}>Ask an admin if you need to invite someone.</span>
        </div>
      ) : (
        <>
          <form noValidate onSubmit={(e) => { e.preventDefault(); invite(); }}
            style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 18, border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)' }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>Invite someone</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input type="email" aria-label="Email address" value={email} placeholder="name@company.com" autoComplete="off"
                onChange={(e) => { setEmail(e.target.value); if (inv.err) setInv({ err: false, text: INVITE_HINT }); }}
                style={{ ...ctl, flex: 1, minWidth: 220, padding: '0 12px', outlineColor: 'var(--acc)', borderColor: inv.err ? 'var(--err)' : 'var(--line)' }} />
              <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as 'estimator' | 'admin')} style={{ ...ctl, padding: '0 10px', fontSize: 13.5 }}>
                <option value="estimator">Estimator</option>
                <option value="admin">Admin</option>
              </select>
              <button type="submit" disabled={sending}
                style={{ height: 40, padding: '0 16px', border: 0, borderRadius: 10, background: 'var(--acc)', color: '#fff', font: 'inherit', fontWeight: 600, fontSize: 13.5, cursor: 'pointer', opacity: sending ? 0.7 : 1 }}>Send invite</button>
            </div>
            <span role="status" style={{ fontSize: 12.5, color: inv.err ? 'var(--err)' : 'var(--ink3)' }}>{inv.text}</span>
          </form>

          <div style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', overflowX: 'auto' }}>
            <div style={{ minWidth: 640 }}>
              <div style={{ display: 'grid', gridTemplateColumns: COLS, fontSize: 12, fontWeight: 600, color: 'var(--ink2)', borderBottom: '1px solid var(--line)' }}>
                <div style={{ padding: '10px 16px' }}>Person</div><div style={{ padding: '10px 8px' }}>Role</div><div style={{ padding: '10px 8px' }}>Status</div><div style={{ padding: '10px 8px' }}>Last active</div><div />
              </div>
              {error && <div style={{ padding: 16, fontSize: 13.5, color: 'var(--err)' }}>{error}</div>}
              {!users && !error && <div style={{ padding: 16, fontSize: 13.5, color: 'var(--ink3)' }}>Loading…</div>}
              {users?.map((u) => {
                const self = u.id === me.id;
                const st = shownStatus(u);
                const c = confirm === u.id;
                const displayName = u.name || u.email.split('@')[0];
                return (
                  <div key={u.id} style={{ borderBottom: '1px solid var(--line2)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', fontSize: 13.5, opacity: st === 'Removed' ? 0.65 : 1 }}>
                      <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                        <span style={{ width: 30, height: 30, flex: 'none', borderRadius: '50%', background: 'var(--sunk)', color: 'var(--ink2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>{initials(u.name, u.email)}</span>
                        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                          <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName}</span>
                          <span style={{ fontSize: 12, color: 'var(--ink3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.email}</span>
                        </span>
                      </div>
                      <div style={{ padding: '6px 8px' }}>
                        <select aria-label={`Role of ${displayName}`} value={u.role} disabled={self || st === 'Removed'} onChange={(e) => setUserRole(u, e.target.value)}
                          style={{ height: 32, width: '100%', padding: '0 8px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 13 }}>
                          <option value="estimator">Estimator</option>
                          <option value="admin">Admin</option>
                        </select>
                      </div>
                      <div style={{ padding: 8 }}><StatusBadge label={st} tone={TONES[st]} /></div>
                      <div style={{ padding: 8, color: 'var(--ink2)', fontSize: 13 }}>{self ? 'Now' : lastActive(u.last_active_at)}</div>
                      <div style={{ padding: '8px 12px 8px 0', display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
                        {self ? (
                          <span style={{ fontSize: 12, color: 'var(--ink3)' }}>You</span>
                        ) : c ? (
                          <>
                            <button type="button" onClick={() => setConfirm(null)} className="hv-sunk" style={act('var(--ink2)')}>Keep</button>
                            <button type="button" autoFocus
                              onClick={() => rowAction(u, () => st === 'Active'
                                ? api(`/api/users/${u.id}`, { method: 'DELETE' })
                                : api(`/api/users/${u.id}/cancel-invite`, { method: 'POST' }))}
                              style={act('#fff', 'var(--err)', 600)}>Confirm</button>
                          </>
                        ) : st === 'Invite expired' ? (
                          <button type="button" className="hv-accSoft" onClick={() => rowAction(u, () => api(`/api/users/${u.id}/resend-invite`, { method: 'POST' }))} style={act('var(--accInk)')}>Resend</button>
                        ) : st === 'Removed' ? (
                          <button type="button" className="hv-sunk" onClick={() => rowAction(u, () => api(`/api/users/${u.id}`, { method: 'PATCH', json: { status: 'active' } }))} style={act('var(--ink2)')}>Restore</button>
                        ) : (
                          <button type="button" className="hv-sunk" onClick={() => { setConfirm(u.id); setRowMsg(null); }} style={act('var(--ink2)')}>
                            {st === 'Invite sent' ? 'Cancel invite' : 'Remove'}
                          </button>
                        )}
                      </div>
                    </div>
                    {c && (
                      <div style={{ padding: '0 16px 10px 56px', fontSize: 12.5, color: 'var(--ink2)' }}>
                        {st === 'Active' ? `${displayName} will be signed out and can no longer sign in. Their estimates stay.` : `The invite link sent to ${u.email} will stop working.`}
                      </div>
                    )}
                    {rowMsg?.id === u.id && <div role="alert" style={{ padding: '0 16px 10px 56px', fontSize: 12.5, color: 'var(--err)' }}>{rowMsg.text}</div>}
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ink3)', lineHeight: 1.5 }}>Estimators can make estimates and manage the knowledge base. Admins can also invite people, set budgets and change model routing.</div>
        </>
      )}
    </SettingsFrame>
  );
}
