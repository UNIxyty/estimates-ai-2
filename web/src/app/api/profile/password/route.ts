import { z } from 'zod';
import { json, readJson, route } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { changePassword } from '@/lib/authFlows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ current: z.string().max(1000), next: z.string().max(1000) });

/** Changes the password and signs out every other session. */
export const POST = route(async (req) => {
  const { user, session } = await requireUser(req);
  const body = await readJson(req, schema);
  await changePassword(user.id, session.id, body.current, body.next);
  return json({ ok: true });
});
