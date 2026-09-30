import { route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { ownedDocument } from '@/lib/access';
import { extOf, streamFile } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const d = await ownedDocument(user.id, uuidParam(p.id));
  const ext = extOf(d.stored_path) || 'xlsx';
  const name = extOf(d.name) === ext ? d.name : `${d.name}.${ext}`;
  return streamFile(d.stored_path, name, 'attachment');
});
