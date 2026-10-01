import { json, route } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { listHistory } from '@/lib/history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The signed-in user's conversations with derived status (In progress / Done / Sent), output file and AI cost. */
export const GET = route(async (req) => {
  const { user } = await requireUser(req);
  return json({ history: await listHistory(user.id) });
});
