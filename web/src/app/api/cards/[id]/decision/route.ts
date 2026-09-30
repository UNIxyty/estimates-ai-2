import { json, readJson, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { decideCard, decisionSchema } from '@/lib/cards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const body = await readJson(req, decisionSchema);
  const r = await decideCard(user.id, uuidParam(p.id), body);
  return json(r.body, r.status);
});
