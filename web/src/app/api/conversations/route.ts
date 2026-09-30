import { z } from 'zod';
import { sql } from '@/lib/db';
import { json, readJson, route } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { listConversations } from '@/lib/conversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (req) => {
  const { user } = await requireUser(req);
  const q = (new URL(req.url).searchParams.get('q') || '').trim().slice(0, 200);
  return json({ conversations: await listConversations(user.id, q) });
});

export const POST = route(async (req) => {
  const { user } = await requireUser(req);
  const body = await readJson(req, z.object({ title: z.string().trim().min(1).max(200).optional() }));
  const row = (await sql`INSERT INTO conversations (user_id, title) VALUES (${user.id}, ${body.title ?? 'New estimate'})
                          RETURNING *`)[0];
  return json({ conversation: row }, 201);
});
