import { intParam, json, route } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { usageReport } from '@/lib/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  const { user } = await requireUser(req);
  const days = intParam(new URL(req.url).searchParams.get('days'), 30, 1, 366);
  return json(await usageReport(user, days));
});
