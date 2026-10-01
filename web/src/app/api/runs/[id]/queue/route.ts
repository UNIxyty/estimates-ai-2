import { json, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { ownedRun } from '@/lib/access';
import { queuePosition } from '@/lib/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/runs/{id}/queue → {status, ahead, running}: shown while a run waits for the worker. */
export const GET = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const run = await ownedRun(user.id, uuidParam(p.id));
  return json(await queuePosition(run.id));
});
