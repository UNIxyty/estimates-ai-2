import { clientIp, json, readJson, route, HttpError } from '@/lib/http';
import { LIMITS, take } from '@/lib/rateLimit';
import { login, loginSchema } from '@/lib/authFlows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (req) => {
  const body = await readJson(req, loginSchema);
  const ip = clientIp(req);
  if (!take(`login:ip:${ip}`, LIMITS.loginIp) || !take(`login:email:${body.email}`, LIMITS.loginEmail)) {
    throw new HttpError(429, 'rate_limited', { message: 'Too many attempts. Try again in a few minutes.' });
  }
  const { cookie } = await login(body.email, body.password, { ip, userAgent: req.headers.get('user-agent') });
  const res = json({ ok: true });
  res.headers.append('Set-Cookie', cookie);
  return res;
});
