import { z } from 'zod';
import { sql } from '@/lib/db';
import { json, readJson, route } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z
  .object({
    name: z.string().trim().max(200).optional(),
    send_estimates_to: z.union([z.string().trim().toLowerCase().email().max(320), z.literal(''), z.null()]).optional(),
  })
  .strict();

async function profile(userId: string) {
  const rows = await sql`
    SELECT id, email::text AS email, name, role, status, send_estimates_to::text AS send_estimates_to,
           COALESCE(send_estimates_to, email)::text AS effective_send_estimates_to, created_at, last_active_at
      FROM users WHERE id = ${userId}`;
  return rows[0];
}

export const GET = route(async (req) => {
  const { user } = await requireUser(req);
  return json({ profile: await profile(user.id) });
});

export const PATCH = route(async (req) => {
  const { user } = await requireUser(req);
  const body = await readJson(req, patchSchema);
  if (body.name !== undefined) await sql`UPDATE users SET name = ${body.name}, updated_at = now() WHERE id = ${user.id}`;
  if (body.send_estimates_to !== undefined) {
    const v = body.send_estimates_to ? body.send_estimates_to : null;
    await sql`UPDATE users SET send_estimates_to = ${v}, updated_at = now() WHERE id = ${user.id}`;
  }
  return json({ profile: await profile(user.id) });
});
