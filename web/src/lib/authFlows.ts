import { z } from 'zod';
import { sql } from './db';
import { HttpError, badRequest } from './http';
import { burnVerify, hashPassword, verifyPassword } from './auth/password';
import { passwordProblem } from './passwordRules';
import { createSession, invalidateUserSessions } from './auth/session';
import { hashToken, inspectToken, issueAuthToken } from './auth/tokens';

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(320),
  password: z.string().max(1000),
});
export const setPasswordSchema = z.object({ token: z.string().min(1).max(200), password: z.string().max(1000) });
export const forgotSchema = z.object({ email: z.string().trim().toLowerCase().max(320) });

type Meta = { userAgent?: string | null; ip?: string | null };

/** Generic failure for every reason (unknown email, wrong password, not active). */
export async function login(email: string, password: string, meta: Meta) {
  const u = (await sql<{ id: string; status: string; password_hash: string | null }[]>`
    SELECT id, status, password_hash FROM users WHERE email = ${email}`)[0];
  if (!u || !u.password_hash) {
    await burnVerify(password);
    throw new HttpError(401, 'invalid_credentials');
  }
  const ok = await verifyPassword(u.password_hash, password);
  if (!ok || u.status !== 'active') throw new HttpError(401, 'invalid_credentials');
  const s = await createSession(u.id, meta);
  await sql`UPDATE users SET last_active_at = now() WHERE id = ${u.id}`;
  return { userId: u.id, cookie: s.cookie };
}

/**
 * Consumes an invite/reset token and sets the password, in one transaction:
 * single-use UPDATE … WHERE used_at IS NULL AND expires_at > now(), other outstanding tokens of the
 * same kind invalidated, all existing sessions killed, then a fresh session is created.
 */
export async function setPasswordWithToken(token: string, password: string, meta: Meta) {
  const problem = passwordProblem(password);
  if (problem) throw badRequest('weak_password', { message: problem });
  const pwHash = await hashPassword(password);
  const result = await sql.begin(async (tx) => {
    const t = (await tx<{ id: string; user_id: string; kind: 'invite' | 'reset' }[]>`
      UPDATE auth_tokens SET used_at = now()
       WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > now()
       RETURNING id, user_id, kind`)[0];
    if (!t) return null;
    const u = (await tx<{ id: string; status: string }[]>`SELECT id, status FROM users WHERE id = ${t.user_id} FOR UPDATE`)[0];
    if (!u || u.status === 'disabled' || (t.kind === 'reset' && u.status !== 'active')) {
      throw new HttpError(400, 'invalid', { state: 'invalid' });
    }
    await tx`UPDATE auth_tokens SET used_at = now()
              WHERE user_id = ${t.user_id} AND kind = ${t.kind} AND used_at IS NULL AND id <> ${t.id}`;
    await tx`UPDATE users SET password_hash = ${pwHash}, status = 'active', updated_at = now() WHERE id = ${t.user_id}`;
    await invalidateUserSessions(t.user_id, tx);
    const s = await createSession(t.user_id, meta, tx);
    return { userId: t.user_id, kind: t.kind, cookie: s.cookie };
  });
  if (!result) {
    const info = await inspectToken(token);
    const state = info.state === 'valid' ? 'invalid' : info.state;
    throw new HttpError(400, state, { state });
  }
  return result;
}

/** Always resolves (the route always answers 200); only active users get a reset link. */
export async function requestReset(email: string): Promise<void> {
  const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} AND status = 'active'`)[0];
  if (!u) return;
  await sql.begin((tx) => issueAuthToken(tx, u.id, 'reset', null));
}

export async function changePassword(userId: string, sessionId: string, current: string, next: string) {
  const problem = passwordProblem(next);
  if (problem) throw badRequest('weak_password', { message: problem });
  const u = (await sql<{ password_hash: string | null }[]>`SELECT password_hash FROM users WHERE id = ${userId}`)[0];
  if (!u || !(await verifyPassword(u.password_hash, current))) throw badRequest('wrong_password');
  const h = await hashPassword(next);
  await sql.begin(async (tx) => {
    await tx`UPDATE users SET password_hash = ${h}, updated_at = now() WHERE id = ${userId}`;
    await invalidateUserSessions(userId, tx, sessionId);
  });
}
