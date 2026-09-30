import { route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { ownedDocument } from '@/lib/access';
import { proxyWorker } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const d = await ownedDocument(user.id, uuidParam(p.id));
  const qs = new URL(req.url).searchParams;
  qs.set('kind', 'document');
  qs.set('id', d.id);
  return proxyWorker(`/internal/view/sheets?${qs.toString()}`);
});
