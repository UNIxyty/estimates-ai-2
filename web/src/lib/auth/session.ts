import { createHmac, randomBytes } from 'node:crypto';
import { sql, type Q } from '../db';
import { env } from '../env';

export const SESSION_COOKIE = 'est_session';
const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_DAYS = 30;
const RENEW_WHEN_DAYS_LEFT = 15;
const ACTIVE_TOUCH_MS = 5 * 60 * 1000;

export type Role = 'estimator' | 'admin';
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'invited' | 'active' | 'disabled';
  send_estimates_to: string | null;
  last_active_at: Date | null;
}
export interface Session {
  id: string;
  user_id: string;
  expires_at: Date;
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** DB session id = hex HMAC-SHA256(SESSION_SECRET, token): a DB leak does not reveal usable cookies. */
export function sessionIdFromToken(token: string): string {
  return createHmac('sha256', env.sessionSecret()).update(token).digest('hex');
}

export function sessionCookie(token: string, expires: Date): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expires.toUTCString()}`,
    `Max-Age=${Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000))}`,
  ];
  if (env.secureCookies()) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (env.secureCookies()) parts.push('Secure');
  return parts.join('; ');
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
  q: Q = sql,
): Promise<{ token: string; expiresAt: Date; cookie: string }> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY_MS);
  await q`INSERT INTO sessions (id, user_id, expires_at, user_agent, ip)
          VALUES (${sessionIdFromToken(token)}, ${userId}, ${expiresAt}, ${meta.userAgent?.slice(0, 400) ?? null}, ${meta.ip ?? null})`;
  return { token, expiresAt, cookie: sessionCookie(token, expiresAt) };
}

export function readCookie(header: string | null, name = SESSION_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return v || null;
    }
  }
  return null;
}

const lastTouch = new Map<string, number>();
const renewals = new WeakMap<Request, string>();

/** Pops a Set-Cookie value recorded by validateSession() during this request (sliding renewal). */
export function takeSessionRenewal(req: Request): string | undefined {
  const v = renewals.get(req);
  renewals.delete(req);
  return v;
}

/**
 * Validates a raw cookie token. Only active users. Extends the session (sliding) when fewer than 15
 * days remain; the new cookie is recorded against `req` so route() can attach it to the response.
 */
export async function validateSessionToken(
  token: string | null,
  req?: Request,
): Promise<{ user: SessionUser; session: Session } | null> {
  if (!token || token.length > 200) return null;
  const sid = sessionIdFromToken(token);
  const rows = await sql<(SessionUser & { session_expires_at: Date })[]>`
    SELECT u.id, u.email::text AS email, u.name, u.role, u.status, u.send_estimates_to::text AS send_estimates_to,
           u.last_active_at, s.expires_at AS session_expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ${sid} AND s.expires_at > now() AND u.status = 'active'`;
  const row = rows[0];
  if (!row) return null;
  const { session_expires_at, ...user } = row;
  let expiresAt = session_expires_at;
  if (expiresAt.getTime() - Date.now() < RENEW_WHEN_DAYS_LEFT * DAY_MS) {
    expiresAt = new Date(Date.now() + SESSION_DAYS * DAY_MS);
    await sql`UPDATE sessions SET expires_at = ${expiresAt} WHERE id = ${sid}`;
    if (req) renewals.set(req, sessionCookie(token, expiresAt));
  }
  const now = Date.now();
  if ((lastTouch.get(user.id) ?? 0) < now - 60_000) {
    lastTouch.set(user.id, now);
    const since = new Date(now - ACTIVE_TOUCH_MS);
    await sql`UPDATE users SET last_active_at = now()
               WHERE id = ${user.id} AND (last_active_at IS NULL OR last_active_at < ${since})`;
  }
  return { user, session: { id: sid, user_id: user.id, expires_at: expiresAt } };
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
}

export async function invalidateUserSessions(userId: string, q: Q = sql, exceptSessionId?: string): Promise<void> {
  if (exceptSessionId) await q`DELETE FROM sessions WHERE user_id = ${userId} AND id <> ${exceptSessionId}`;
  else await q`DELETE FROM sessions WHERE user_id = ${userId}`;
}
