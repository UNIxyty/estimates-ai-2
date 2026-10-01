import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { passwordProblem } from '@/lib/passwordRules';
import { hashToken } from '@/lib/auth/tokens';
import { resetRateLimits } from '@/lib/rateLimit';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as logout } from '@/app/api/auth/logout/route';
import { POST as setPassword } from '@/app/api/auth/set-password/route';
import { POST as forgot } from '@/app/api/auth/forgot/route';
import { GET as tokenState } from '@/app/api/auth/token/route';
import { GET as me } from '@/app/api/auth/me/route';
import { POST as invite } from '@/app/api/users/invite/route';
import { POST as resend } from '@/app/api/users/[id]/resend-invite/route';
import { POST as changePassword } from '@/app/api/profile/password/route';
import { Fixtures, PASSWORD, call } from './helpers';

const fx = new Fixtures();
afterAll(() => fx.cleanup());
beforeEach(() => resetRateLimits());

const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;
const state = (token: string) => call(tokenState, { url: `http://localhost/api/auth/token?token=${encodeURIComponent(token)}` });
const doSet = (token: string, password: string) => call(setPassword, { method: 'POST', json: { token, password } });

async function invited(email = `new-${crypto.randomUUID()}@test.local`) {
  const admin = await fx.user({ role: 'admin' });
  const r = await call(invite, { method: 'POST', cookie: admin.cookie, json: { email, name: 'Newbie', role: 'estimator' } });
  expect(r.status).toBe(201);
  fx.users.push(r.body.user.id);
  return { admin, user: r.body.user, token: tokenOf(r.body.invite_url), email };
}

describe('password rules and hashing', () => {
  it('requires ≥10 characters and a number', () => {
    expect(passwordProblem('short1')).toMatch(/10 characters/);
    expect(passwordProblem('longenoughbutnodigits')).toMatch(/number/);
    expect(passwordProblem('longenough1')).toBeNull();
  });

  it('hashes with argon2id (m=19456,t=2,p=1) as a PHC string', async () => {
    const h = await hashPassword('longenough1');
    expect(h.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(await verifyPassword(h, 'longenough1')).toBe(true);
    expect(await verifyPassword(h, 'longenough2')).toBe(false);
  });

  const py = process.env.ARGON2_PYTHON || '/home/user/estimates-ai-2/worker/.venv/bin/python';
  it.skipIf(!existsSync(py))('hashes interoperate with Python argon2-cffi (worker seed script)', async () => {
    const h = await hashPassword('longenough1');
    const out = execFileSync(py, ['-c', `
import sys
from argon2 import PasswordHasher
ph = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
print(ph.verify(sys.argv[1], 'longenough1'))
print(ph.hash('fromPython123'))
`, h]).toString().trim().split('\n');
    expect(out[0]).toBe('True');
    expect(out[1].startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(out[1], 'fromPython123')).toBe(true);
  });
});

describe('invite → set password', () => {
  it('rejects a weak password server-side without consuming the token', async () => {
    const { token } = await invited();
    const r = await doSet(token, 'short1');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('weak_password');
    expect((await state(token)).body.state).toBe('valid');
  });

  it('token is single use; the account becomes active with a session cookie', async () => {
    const { token, user, email } = await invited();
    const s = await state(token);
    expect(s.body).toEqual({ state: 'valid', kind: 'invite', email, inviter: 'Test User' });
    const r = await doSet(token, 'a-good-password-1');
    expect(r.status).toBe(200);
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^est_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure'); // APP_URL is http in tests
    const u = (await sql<{ status: string; password_hash: string }[]>`SELECT status, password_hash FROM users WHERE id = ${user.id}`)[0];
    expect(u.status).toBe('active');
    expect(u.password_hash.startsWith('$argon2id$')).toBe(true);
    const meRes = await call(me, { cookie: cookie.split(';')[0] });
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe(email);

    expect((await state(token)).body.state).toBe('used');
    const again = await doSet(token, 'another-password-2');
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('used');
  });

  it('two concurrent set-password calls with the same token: exactly one succeeds', async () => {
    const { token } = await invited();
    const rs = await Promise.all([doSet(token, 'a-good-password-1'), doSet(token, 'a-good-password-2')]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('expired invite → state expired and set-password refused', async () => {
    const { token } = await invited();
    await sql`UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = ${hashToken(token)}`;
    expect((await state(token)).body.state).toBe('expired');
    const r = await doSet(token, 'a-good-password-1');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('expired');
  });

  it('invites expire after 7 days; a new invite invalidates the older one', async () => {
    const { token, admin, user } = await invited();
    const t = (await sql<{ secs: number }[]>`SELECT extract(epoch FROM expires_at - created_at)::int AS secs FROM auth_tokens WHERE token_hash = ${hashToken(token)}`)[0];
    expect(t.secs).toBeGreaterThanOrEqual(7 * 86400 - 5);
    expect(t.secs).toBeLessThanOrEqual(7 * 86400 + 5);
    const r = await call(resend, { method: 'POST', cookie: admin.cookie, params: { id: user.id } });
    expect(r.status).toBe(200);
    expect((await state(token)).body.state).toBe('expired');
    expect((await state(tokenOf(r.body.invite_url))).body.state).toBe('valid');
  });

  it('unknown tokens are invalid', async () => {
    expect((await state('nope')).body).toEqual({ state: 'invalid', kind: null, email: null });
    expect((await call(tokenState, { url: 'http://localhost/api/auth/token' })).body.state).toBe('invalid');
  });
});

describe('forgot / reset', () => {
  const resetJobs = (userId: string) =>
    sql<{ payload: { url: string; kind: string } }[]>`
      SELECT payload FROM jobs WHERE kind = 'send_auth_email' AND payload->>'user_id' = ${userId} AND payload->>'kind' = 'reset' ORDER BY id`;

  it('always 200; only active users get a reset (1 hour), reset kills all sessions', async () => {
    const u = await fx.user();
    const unknown = await call(forgot, { method: 'POST', json: { email: 'nobody-here@test.local' } });
    expect(unknown.status).toBe(200);
    const invitedOnly = await fx.user({ status: 'invited', password: null });
    expect((await call(forgot, { method: 'POST', json: { email: invitedOnly.email } })).status).toBe(200);
    expect(await resetJobs(invitedOnly.id)).toHaveLength(0);

    const r = await call(forgot, { method: 'POST', json: { email: u.email.toUpperCase() } });
    expect(r.status).toBe(200);
    const jobs = await resetJobs(u.id);
    expect(jobs).toHaveLength(1);
    const token = tokenOf(jobs[0].payload.url);
    const t = (await sql<{ secs: number }[]>`SELECT extract(epoch FROM expires_at - created_at)::int AS secs FROM auth_tokens WHERE token_hash = ${hashToken(token)}`)[0];
    expect(t.secs).toBeGreaterThanOrEqual(3595);
    expect(t.secs).toBeLessThanOrEqual(3605);
    expect((await state(token)).body).toMatchObject({ state: 'valid', kind: 'reset' });

    expect((await call(me, { cookie: u.cookie })).status).toBe(200);
    const s = await doSet(token, 'brand-new-password-9');
    expect(s.status).toBe(200);
    expect((await call(me, { cookie: u.cookie })).status).toBe(401); // old session killed
    expect((await call(login, { method: 'POST', json: { email: u.email, password: 'brand-new-password-9' } })).status).toBe(200);
  });

  it('a reset link stops working after 1 hour', async () => {
    const u = await fx.user();
    await call(forgot, { method: 'POST', json: { email: u.email } });
    const token = tokenOf((await resetJobs(u.id))[0].payload.url);
    await sql`UPDATE auth_tokens SET created_at = now() - interval '61 minutes', expires_at = now() - interval '1 minute'
               WHERE token_hash = ${hashToken(token)}`;
    expect((await state(token)).body.state).toBe('expired');
    expect((await doSet(token, 'brand-new-password-9')).body.error).toBe('expired');
  });
});

describe('login / logout / password change', () => {
  it('logs in active users only, with a generic error', async () => {
    const u = await fx.user();
    const ok = await call(login, { method: 'POST', json: { email: u.email, password: PASSWORD } });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    expect((await call(me, { cookie })).status).toBe(200);

    const wrong = await call(login, { method: 'POST', json: { email: u.email, password: 'wrong-password-1' } });
    const missing = await call(login, { method: 'POST', json: { email: 'missing@test.local', password: PASSWORD } });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body).toEqual(missing.body);

    const disabled = await fx.user({ status: 'disabled' });
    expect((await call(login, { method: 'POST', json: { email: disabled.email, password: PASSWORD } })).status).toBe(401);

    const out = await call(logout, { method: 'POST', cookie });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await call(me, { cookie })).status).toBe(401);
  });

  it('rate-limits repeated login attempts for one email', async () => {
    const u = await fx.user();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await call(login, { method: 'POST', json: { email: u.email, password: 'wrong-password-1' } })).status);
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 401).length).toBe(8);
  });

  it('password change checks the current password and rules, and signs out other sessions', async () => {
    const u = await fx.user();
    const other = await call(login, { method: 'POST', json: { email: u.email, password: PASSWORD } });
    const otherCookie = other.headers.get('set-cookie')!.split(';')[0];
    expect((await call(changePassword, { method: 'POST', cookie: u.cookie, json: { current: 'nope', next: 'new-password-123' } })).body.error).toBe('wrong_password');
    expect((await call(changePassword, { method: 'POST', cookie: u.cookie, json: { current: PASSWORD, next: 'short' } })).body.error).toBe('weak_password');
    const ok = await call(changePassword, { method: 'POST', cookie: u.cookie, json: { current: PASSWORD, next: 'new-password-123' } });
    expect(ok.status).toBe(200);
    expect((await call(me, { cookie: u.cookie })).status).toBe(200);
    expect((await call(me, { cookie: otherCookie })).status).toBe(401);
  });
});

describe('sessions', () => {
  it('stores only an HMAC of the token and renews sessions with <15 days left', async () => {
    const u = await fx.user();
    const rows = await sql<{ id: string }[]>`SELECT id FROM sessions WHERE user_id = ${u.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].id).not.toContain(u.token);
    await sql`UPDATE sessions SET expires_at = now() + interval '3 days' WHERE user_id = ${u.id}`;
    const r = await call(me, { cookie: u.cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toContain(`est_session=${u.token}`);
    const exp = (await sql<{ days: number }[]>`SELECT extract(epoch FROM expires_at - now()) / 86400 AS days FROM sessions WHERE user_id = ${u.id}`)[0];
    expect(Number(exp.days)).toBeGreaterThan(29);
  });
});
