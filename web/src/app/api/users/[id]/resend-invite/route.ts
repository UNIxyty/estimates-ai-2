import { json, route, uuidParam } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/guard';
import { resendInvite } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route<{ id: string }>(async (req, p) => {
  const { user } = await requireAdmin(req);
  return json(await resendInvite(user.id, uuidParam(p.id)));
});
