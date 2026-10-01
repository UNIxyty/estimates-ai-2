import { json, route } from '@/lib/http';
import { describeToken } from '@/lib/authFlows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** { state: valid|expired|used|invalid, kind: invite|reset|null, email } (+ inviter: string|null for a valid invite). */
export const GET = route(async (req) => {
  const token = new URL(req.url).searchParams.get('token');
  return json(await describeToken(token));
});
