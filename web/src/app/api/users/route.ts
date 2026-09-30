import { json, route } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/guard';
import { listUsers } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  await requireAdmin(req);
  return json({ users: await listUsers() });
});
