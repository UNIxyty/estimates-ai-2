import { json, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { visibleFile } from '@/lib/access';
import { usedInFor } from '@/lib/knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const f = await visibleFile(uuidParam(p.id));
  return json({ usedIn: await usedInFor(user.id, f.id) });
});
