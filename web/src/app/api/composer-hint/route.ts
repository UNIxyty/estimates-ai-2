import { json, route } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { composerHint } from '@/lib/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  await requireUser(req);
  return json(await composerHint());
});
