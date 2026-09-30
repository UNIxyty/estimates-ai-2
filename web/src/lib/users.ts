import { z } from 'zod';
import { sql, type Tx } from './db';
import { HttpError, badRequest, notFound } from './http';
import { issueAuthToken } from './auth/tokens';
import { invalidateUserSessions } from './auth/session';

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().max(200).optional().default(''),
  role: z.enum(['estimator', 'admin']).optional().default('estimator'),
});

export const patchUserSchema = z
  .object({
    role: z.enum(['estimator', 'admin']).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    name: z.string().trim().max(200).optional(),
  })
  .strict();

const userCols = () => sql`id, email::text AS email, name, role, status, send_estimates_to::text AS send_estimates_to,
                      created_at, updated_at, last_active_at`;

export async function listUsers() {
  return sql`
    SELECT ${userCols()},
           (SELECT max(t.expires_at) FROM auth_tokens t
             WHERE t.user_id = users.id AND t.kind = 'invite' AND t.used_at IS NULL) AS invite_expires_at
      FROM users ORDER BY created_at`;
}

/** Locks the active-admin set and fails if `targetId` is the last active admin. */
async function guardLastAdmin(tx: Tx, targetId: string) {
  const admins = await tx<{ id: string }[]>`
    SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id FOR UPDATE`;
  if (admins.length <= 1 && admins.some((a) => a.id === targetId)) {
    throw new HttpError(409, 'last_admin', { message: 'The last active admin cannot be demoted or disabled.' });
  }
}

export async function inviteUser(adminId: string, input: z.infer<typeof inviteSchema>) {
  return sql.begin(async (tx) => {
    const existing = (await tx<{ id: string; status: string }[]>`
      SELECT id, status FROM users WHERE email = ${input.email} FOR UPDATE`)[0];
    let userId: string;
    if (existing) {
      if (existing.status === 'active') throw new HttpError(409, 'user_exists');
      if (existing.status === 'disabled') throw new HttpError(409, 'user_disabled');
      userId = existing.id;
      await tx`UPDATE users SET name = ${input.name}, role = ${input.role}, updated_at = now() WHERE id = ${userId}`;
    } else {
      const row = (await tx<{ id: string }[]>`
        INSERT INTO users (email, name, role, status) VALUES (${input.email}, ${input.name}, ${input.role}, 'invited')
        RETURNING id`)[0];
      userId = row.id;
    }
    const link = await issueAuthToken(tx, userId, 'invite', adminId);
    const user = (await tx`SELECT ${userCols()} FROM users WHERE id = ${userId}`)[0];
    return { user, invite_url: link.url, invite_expires_at: link.expiresAt };
  });
}

export async function resendInvite(adminId: string, userId: string) {
  return sql.begin(async (tx) => {
    const u = (await tx<{ id: string; status: string }[]>`SELECT id, status FROM users WHERE id = ${userId} FOR UPDATE`)[0];
    if (!u) throw notFound();
    if (u.status !== 'invited') throw badRequest('not_invited');
    const link = await issueAuthToken(tx, userId, 'invite', adminId);
    return { ok: true, invite_url: link.url, invite_expires_at: link.expiresAt };
  });
}

export async function patchUser(adminId: string, userId: string, input: z.infer<typeof patchUserSchema>) {
  return sql.begin(async (tx) => {
    const u = (await tx<{ id: string; role: string; status: string; password_hash: string | null }[]>`
      SELECT id, role, status, password_hash FROM users WHERE id = ${userId}`)[0];
    if (!u) throw notFound();
    const demoting = input.role !== undefined && input.role !== 'admin' && u.role === 'admin';
    const disabling = input.status === 'disabled' && u.status !== 'disabled';
    if ((demoting || disabling) && u.role === 'admin' && u.status === 'active') await guardLastAdmin(tx, userId);
    if (disabling && userId === adminId) throw badRequest('cannot_disable_self');
    if (input.status === 'active' && u.status !== 'active' && !u.password_hash) {
      throw badRequest('no_password', { message: 'This user has not accepted the invite yet.' });
    }
    const row = (await tx`
      UPDATE users SET role = COALESCE(${input.role ?? null}, role),
                       status = COALESCE(${input.status ?? null}, status),
                       name = COALESCE(${input.name ?? null}, name),
                       updated_at = now()
       WHERE id = ${userId} RETURNING ${userCols()}`)[0];
    if (disabling) await invalidateUserSessions(userId, tx);
    return { user: row };
  });
}

export async function disableUser(adminId: string, userId: string) {
  return patchUser(adminId, userId, { status: 'disabled' });
}
