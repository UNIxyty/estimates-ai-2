import { route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { visibleFile } from '@/lib/access';
import { streamFile } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>(async (req, p) => {
  await requireUser(req);
  const f = await visibleFile(uuidParam(p.id));
  return streamFile(f.stored_path, f.original_name, 'attachment');
});
