import { route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { streamFile } from '@/lib/storage';
import { ownedUpload } from '../owned';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Download a chat attachment (owner only). */
export const GET = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const u = await ownedUpload(user.id, uuidParam(p.id));
  return streamFile(u.stored_path, u.original_name, 'attachment');
});
