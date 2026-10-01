import { json, readJson, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { deleteItem, itemPatchSchema, patchItem } from '@/lib/knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route<{ id: string; itemId: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const body = await readJson(req, itemPatchSchema);
  return json(await patchItem(user, uuidParam(p.id), uuidParam(p.itemId), body));
});

export const DELETE = route<{ id: string; itemId: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  return json(await deleteItem(user, uuidParam(p.id), uuidParam(p.itemId)));
});
