import { createHash, randomBytes } from 'node:crypto';
import { sql, type Q, type Tx } from '../db';
import { env } from '../env';
import { enqueueJob } from '../jobs';

export type TokenKind = 'invite' | 'reset';
export type TokenState = 'valid' | 'expired' | 'used' | 'invalid';
export const TOKEN_TTL_SECONDS: Record<TokenKind, number> = { invite: 7 * 24 * 3600, reset: 3600 };

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function setPasswordUrl(token: string): string {
  return `${env.appUrl()}/set-password?token=${encodeURIComponent(token)}`;
}

/**
 * Issue an invite/reset link: older outstanding links of the same kind stop working (expired), the
 * new token's sha256 is stored, and a send_auth_email job is queued for the worker.
 */
export async function issueAuthToken(
  tx: Tx,
  userId: string,
  kind: TokenKind,
  createdBy: string | null,
): Promise<{ token: string; url: string; expiresAt: Date }> {
  await tx`UPDATE auth_tokens SET expires_at = LEAST(expires_at, now() - interval '1 second')
            WHERE user_id = ${userId} AND kind = ${kind} AND used_at IS NULL AND expires_at > now()`;
  const token = randomBytes(32).toString('base64url');
  const rows = await tx<{ expires_at: Date }[]>`
    INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at, created_by)
    VALUES (${userId}, ${kind}, ${hashToken(token)}, now() + make_interval(secs => ${TOKEN_TTL_SECONDS[kind]}), ${createdBy})
    RETURNING expires_at`;
  const url = setPasswordUrl(token);
  await enqueueJob(tx, 'send_auth_email', { user_id: userId, kind, url });
  return { token, url, expiresAt: rows[0].expires_at };
}

export async function inspectToken(
  token: string | null | undefined,
  q: Q = sql,
): Promise<{ state: TokenState; kind: TokenKind | null; email: string | null; user_id: string | null }> {
  if (!token || token.length > 200) return { state: 'invalid', kind: null, email: null, user_id: null };
  const rows = await q<{ kind: TokenKind; used_at: Date | null; expired: boolean; email: string; user_id: string; status: string }[]>`
    SELECT t.kind, t.used_at, (t.expires_at <= now()) AS expired, u.email::text AS email, u.id AS user_id, u.status
      FROM auth_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ${hashToken(token)}`;
  const r = rows[0];
  if (!r) return { state: 'invalid', kind: null, email: null, user_id: null };
  let state: TokenState = r.used_at ? 'used' : r.expired ? 'expired' : 'valid';
  // A disabled account cannot be (re)activated through an old link.
  if (state === 'valid' && r.status === 'disabled') state = 'invalid';
  if (state === 'valid' && r.kind === 'reset' && r.status !== 'active') state = 'invalid';
  return { state, kind: r.kind, email: r.email, user_id: r.user_id };
}
