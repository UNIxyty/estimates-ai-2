import { z } from 'zod';
import { sql } from '@/lib/db';
import { badRequest, json, readJson, route } from '@/lib/http';
import { requireAdmin, requireUser } from '@/lib/auth/guard';
import { defaultPrices, defaultRouting, getSetting, pricesSchema, putSetting, routingSchema } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function current() {
  const [routing, prices] = await Promise.all([getSetting('routing', defaultRouting), getSetting('prices', defaultPrices)]);
  return { routing: routing.value, prices: prices.value, is_default: { routing: routing.is_default, prices: prices.is_default } };
}

export const GET = route(async (req) => {
  await requireUser(req);
  return json(await current());
});

/** Admin only. Body: {routing?, prices?} — each validated and stored under its own settings key. */
export const PUT = route(async (req) => {
  const { user } = await requireAdmin(req);
  const body = await readJson(req, z.object({ routing: routingSchema.optional(), prices: pricesSchema.optional() }).strict());
  if (!body.routing && !body.prices) throw badRequest('nothing_to_update');
  await sql.begin(async (tx) => {
    if (body.routing) await putSetting('routing', body.routing, user.id, tx);
    if (body.prices) await putSetting('prices', body.prices, user.id, tx);
  });
  return json(await current());
});
