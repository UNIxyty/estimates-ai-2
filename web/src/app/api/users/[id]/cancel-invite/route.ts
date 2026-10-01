import { json, route, uuidParam } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/guard';
import { cancelInvite } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Admin only. Withdraws an invite that has not been accepted yet (deletes the never-used account). */
export const POST = route<{ id: string }>(async (req, p) => {
  await requireAdmin(req);
  return json(await cancelInvite(uuidParam(p.id)));
});
