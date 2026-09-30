import { json, readJson, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { postMessage, postMessageSchema } from '@/lib/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const id = uuidParam(p.id);
  const body = await readJson(req, postMessageSchema);
  return json(await postMessage(user.id, id, body), 201);
});
