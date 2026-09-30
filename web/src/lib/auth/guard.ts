import { HttpError } from '../http';
import { readCookie, validateSessionToken, type Session, type SessionUser } from './session';

export interface AuthCtx {
  user: SessionUser;
  session: Session;
}

/** Every API permission check starts here. 401 when there is no valid session for an active user. */
export async function requireUser(req: Request): Promise<AuthCtx> {
  const token = readCookie(req.headers.get('cookie'));
  const res = await validateSessionToken(token, req);
  if (!res) throw new HttpError(401, 'unauthenticated');
  return res;
}

export async function requireAdmin(req: Request): Promise<AuthCtx> {
  const ctx = await requireUser(req);
  if (ctx.user.role !== 'admin') throw new HttpError(403, 'forbidden');
  return ctx;
}

export async function optionalUser(req: Request): Promise<AuthCtx | null> {
  return validateSessionToken(readCookie(req.headers.get('cookie')), req);
}

export function publicUser(u: SessionUser) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    send_estimates_to: u.send_estimates_to,
  };
}
