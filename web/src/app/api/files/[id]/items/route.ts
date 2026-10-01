import { intParam, json, readJson, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { addItem, itemCreateSchema, listItems } from '@/lib/knowledge';

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

/** Adds a saved number by hand (uploader or admin). */
export const POST = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const body = await readJson(req, itemCreateSchema);
  return json(await addItem(user, uuidParam(p.id), body), 201);
});
