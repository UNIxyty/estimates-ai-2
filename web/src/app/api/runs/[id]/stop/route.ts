import { json, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { ownedRun } from '@/lib/access';
import { stopRun } from '@/lib/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const run = await ownedRun(user.id, uuidParam(p.id));
  return json(await stopRun(run.id));
});
