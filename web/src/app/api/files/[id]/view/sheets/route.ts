import { route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { visibleFile } from '@/lib/access';
import { proxyWorker } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>(async (req, p) => {
  await requireUser(req);
  const f = await visibleFile(uuidParam(p.id));
  const qs = new URL(req.url).searchParams;
  qs.set('kind', 'file');
  qs.set('id', f.id);
  return proxyWorker(`/internal/view/sheets?${qs.toString()}`);
});
