import { clientIp, json, readJson, route, HttpError } from '@/lib/http';
import { LIMITS, take } from '@/lib/rateLimit';
import { forgotSchema, requestReset } from '@/lib/authFlows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Always 200 (no account enumeration); only active users receive a reset link. */
export const POST = route(async (req) => {
  const body = await readJson(req, forgotSchema);
  if (!take(`forgot:ip:${clientIp(req)}`, LIMITS.forgotIp)) {
    throw new HttpError(429, 'rate_limited', { message: 'Too many requests. Try again later.' });
  }
  if (body.email && take(`forgot:email:${body.email}`, LIMITS.forgotEmail)) {
    try {
      await requestReset(body.email);
    } catch (e) {
      console.error('[auth] forgot failed', e);
    }
  }
  return json({ ok: true });
});
