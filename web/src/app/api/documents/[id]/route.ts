import { json, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { ownedDocument } from '@/lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const { stored_path: _s, ...doc } = await ownedDocument(user.id, uuidParam(p.id));
  return json({ document: doc });
});
