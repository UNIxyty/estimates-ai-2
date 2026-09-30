import { json, route } from '@/lib/http';
import { inspectToken } from '@/lib/auth/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  const token = new URL(req.url).searchParams.get('token');
  const info = await inspectToken(token);
  return json({ state: info.state, kind: info.kind, email: info.state === 'invalid' ? null : info.email });
});
