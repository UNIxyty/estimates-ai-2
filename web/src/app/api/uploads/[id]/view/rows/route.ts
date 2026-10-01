import { route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { proxyWorker } from '@/lib/worker';
import { ownedUpload } from '../../owned';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Viewer for a chat attachment (owner only). */
export const GET = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const u = await ownedUpload(user.id, uuidParam(p.id));
  const qs = new URL(req.url).searchParams;
  qs.set('kind', 'upload');
  qs.set('id', u.id);
  return proxyWorker(`/internal/view/rows?${qs.toString()}`);
});
