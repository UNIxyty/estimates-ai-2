import { z } from 'zod';
import { json, readJson, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { deleteFile, fileDetail, setTag, tagSchema } from '@/lib/knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  return json(await fileDetail(user.id, uuidParam(p.id)));
});

export const PATCH = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const body = await readJson(req, z.object({ tag: tagSchema }).strict());
  return json(await setTag(user, uuidParam(p.id), body.tag));
});

export const DELETE = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  return json(await deleteFile(user, uuidParam(p.id)));
});
