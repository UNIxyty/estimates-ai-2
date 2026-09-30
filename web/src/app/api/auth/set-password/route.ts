import { clientIp, json, readJson, route } from '@/lib/http';
import { setPasswordSchema, setPasswordWithToken } from '@/lib/authFlows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (req) => {
  const body = await readJson(req, setPasswordSchema);
  const r = await setPasswordWithToken(body.token, body.password, {
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent'),
  });
  const res = json({ ok: true, kind: r.kind });
  res.headers.append('Set-Cookie', r.cookie);
  return res;
});
