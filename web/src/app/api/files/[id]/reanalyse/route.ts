import { json, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { reanalyse } from '@/lib/knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  return json(await reanalyse(user, uuidParam(p.id)));
});
