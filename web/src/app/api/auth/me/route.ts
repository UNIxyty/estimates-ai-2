import { json, route } from '@/lib/http';
import { publicUser, requireUser } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  const { user } = await requireUser(req);
  return json({ user: publicUser(user) });
});
