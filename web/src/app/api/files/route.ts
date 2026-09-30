import { json, route } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { listFiles, uploadKnowledgeFile } from '@/lib/knowledge';
import { badRequest } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  await requireUser(req);
  return json({ files: await listFiles() });
});

export const POST = route(async (req) => {
  const { user } = await requireUser(req);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest('multipart_required');
  }
  return json({ file: await uploadKnowledgeFile(user, form) }, 201);
});
