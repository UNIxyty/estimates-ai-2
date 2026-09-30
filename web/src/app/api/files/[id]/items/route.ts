import { intParam, json, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { listItems } from '@/lib/knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>(async (req, p) => {
  await requireUser(req);
  const sp = new URL(req.url).searchParams;
  return json(
    await listItems(uuidParam(p.id), {
      offset: intParam(sp.get('offset'), 0, 0, 10_000_000),
      limit: intParam(sp.get('limit'), 50, 1, 500),
      q: (sp.get('q') || '').trim().slice(0, 200),
      kind: sp.get('kind'),
    }),
  );
});
