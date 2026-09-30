import { json, readJson, route } from '@/lib/http';
import { requireAdmin, requireUser } from '@/lib/auth/guard';
import { budgetSchema, budgetStatus, defaultBudget, getSetting, putSetting } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  await requireUser(req);
  const b = await getSetting('budget', defaultBudget);
  return json({ budget: b.value, is_default: b.is_default, status: await budgetStatus() });
});

export const PUT = route(async (req) => {
  const { user } = await requireAdmin(req);
  const body = await readJson(req, budgetSchema);
  await putSetting('budget', body, user.id);
  return json({ budget: body, is_default: false, status: await budgetStatus() });
});
