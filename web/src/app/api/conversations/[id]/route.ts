import { z } from 'zod';
import { sql } from '@/lib/db';
import { json, readJson, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { ownedConversation } from '@/lib/access';
import { conversationDetail } from '@/lib/conversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  return json(await conversationDetail(user.id, uuidParam(p.id)));
});

export const PATCH = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const id = uuidParam(p.id);
  await ownedConversation(user.id, id);
  const body = await readJson(req, z.object({ title: z.string().trim().min(1).max(200) }).strict());
  const row = (await sql`UPDATE conversations SET title = ${body.title}, updated_at = now() WHERE id = ${id} RETURNING *`)[0];
  return json({ conversation: row });
});

/** Deletes the conversation (cascades messages, runs, cards, documents rows). Active runs are cancelled first. */
export const DELETE = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const id = uuidParam(p.id);
  await ownedConversation(user.id, id);
  await sql.begin(async (tx) => {
    const runs = await tx<{ id: string }[]>`
      UPDATE runs SET cancel_requested = true
       WHERE conversation_id = ${id} AND status IN ('queued','running','waiting','paused_cost') RETURNING id`;
    for (const r of runs) await tx`SELECT pg_notify('run_cancel', ${r.id})`;
    await tx`DELETE FROM conversations WHERE id = ${id}`;
  });
  return json({ ok: true });
});
