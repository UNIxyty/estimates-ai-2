import { json, route } from '@/lib/http';
import { clearSessionCookie, invalidateSession, readCookie, sessionIdFromToken } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (req) => {
  const token = readCookie(req.headers.get('cookie'));
  if (token) await invalidateSession(sessionIdFromToken(token));
  const res = json({ ok: true });
  res.headers.append('Set-Cookie', clearSessionCookie());
  return res;
});
