import { json, readJson, route, uuidParam } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/guard';
import { disableUser, patchUser, patchUserSchema } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route<{ id: string }>(async (req, p) => {
  const { user } = await requireAdmin(req);
  const body = await readJson(req, patchUserSchema);
  return json(await patchUser(user.id, uuidParam(p.id), body));
});

/** Disables the user and kills their sessions (rows are kept for history). */
export const DELETE = route<{ id: string }>(async (req, p) => {
  const { user } = await requireAdmin(req);
  return json(await disableUser(user.id, uuidParam(p.id)));
});
