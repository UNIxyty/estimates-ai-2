import { json, readJson, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { deleteFile, fileDetail, filePatchSchema, updateFile } from '@/lib/knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  return json(await fileDetail(user.id, uuidParam(p.id)));
});

export const PATCH = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  // { tag?, market?, client?, package? } — uploader or admin.
  const body = await readJson(req, filePatchSchema);
  return json(await updateFile(user, uuidParam(p.id), body));
});

export const DELETE = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  return json(await deleteFile(user, uuidParam(p.id)));
});
