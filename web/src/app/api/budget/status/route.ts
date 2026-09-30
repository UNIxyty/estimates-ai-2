import { json, route } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { budgetMessage, budgetStatus } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  await requireUser(req);
  const b = await budgetStatus();
  return json({
    ...b,
    blocked: b.state === 'over' && b.action === 'pause',
    fast_only: b.state === 'over' && b.action === 'fast_only',
    message: budgetMessage(b),
  });
});
