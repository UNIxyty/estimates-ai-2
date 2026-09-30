import { json, readJson, route } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/guard';
import { inviteSchema, inviteUser } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (req) => {
  const { user } = await requireAdmin(req);
  const body = await readJson(req, inviteSchema);
  return json(await inviteUser(user.id, body), 201);
});
