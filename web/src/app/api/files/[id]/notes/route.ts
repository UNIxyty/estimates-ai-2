import { json, readJson, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { addNote, noteSchema } from '@/lib/knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const body = await readJson(req, noteSchema);
  return json(await addNote(user, uuidParam(p.id), body.text), 201);
});
