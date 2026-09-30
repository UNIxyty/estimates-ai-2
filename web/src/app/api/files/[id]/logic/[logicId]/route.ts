import { json, readJson, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { logicPatchSchema, patchLogic } from '@/lib/knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route<{ id: string; logicId: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const body = await readJson(req, logicPatchSchema);
  return json(await patchLogic(user, uuidParam(p.id), uuidParam(p.logicId), body));
});
