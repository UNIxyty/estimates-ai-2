import { z } from 'zod';
import { json, sql } from './db';
import { env } from './env';
import { HttpError, badRequest } from './http';
import { enqueueJob } from './jobs';
import { ownedConversation } from './access';
import { budgetStatus } from './settings';

/** Runs the UI re-attaches to (stream still meaningful). */
export const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting', 'paused_cost'] as const;
/**
 * Runs that block a new message. 'waiting' (parked on a card, up to 30 min) and 'paused_cost' do not
 * block: the user may keep chatting while a card is open.
 */
export const BLOCKING_RUN_STATUSES = ['queued', 'running'] as const;

export const postMessageSchema = z.object({
  text: z.string().trim().min(1, 'Message is empty').max(20000),
  attachment_ids: z.array(z.string().uuid()).max(20).optional().default([]),
  reference_ids: z.array(z.string().uuid()).max(50).optional().default([]),
});
export type PostMessageInput = z.infer<typeof postMessageSchema>;

export async function chatUnlocked(): Promise<boolean> {
  const rows = await sql<{ ok: boolean }[]>`SELECT chat_unlocked() AS ok`;
  return rows[0].ok;
}

export function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 60) return oneLine || 'New estimate';
  const cut = oneLine.slice(0, 60);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 30 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/**
 * POST /api/conversations/{id}/messages. Checks, in order: owner (404), chat unlocked (409),
 * budget (402 when over + pause), no queued/running run (409), references analysed, attachments owned.
 */
export async function postMessage(userId: string, conversationId: string, input: PostMessageInput) {
  await ownedConversation(userId, conversationId);
  if (!(await chatUnlocked())) throw new HttpError(409, 'chat_locked');

  const budget = await budgetStatus();
  let tierOverride: string | null = null;
  if (budget.state === 'over' && budget.action === 'pause') throw new HttpError(402, 'budget_paused');
  if (budget.state === 'over' && budget.action === 'fast_only') tierOverride = 'fast';

  const referenceIds = [...new Set(input.reference_ids)];
  const attachmentIds = [...new Set(input.attachment_ids)];

  return sql.begin(async (tx) => {
    // Serialise concurrent posts to the same conversation.
    const conv = (await tx<{ id: string; title: string }[]>`
      SELECT id, title FROM conversations WHERE id = ${conversationId} AND user_id = ${userId} FOR UPDATE`)[0];
    if (!conv) throw new HttpError(404, 'not_found');

    const active = await tx<{ id: string }[]>`
      SELECT id FROM runs WHERE conversation_id = ${conversationId}
         AND status = ANY(${BLOCKING_RUN_STATUSES as unknown as string[]}::text[]) LIMIT 1`;
    if (active[0]) throw new HttpError(409, 'run_active', { run_id: active[0].id });

    if (referenceIds.length) {
      const ok = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM files
         WHERE id = ANY(${referenceIds}::uuid[]) AND status = 'analysed' AND deleted_at IS NULL`;
      if (ok[0].n !== referenceIds.length) throw badRequest('invalid_reference');
    }
    if (attachmentIds.length) {
      const ok = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM uploads
         WHERE id = ANY(${attachmentIds}::uuid[]) AND user_id = ${userId}
           AND (conversation_id IS NULL OR conversation_id = ${conversationId})`;
      if (ok[0].n !== attachmentIds.length) throw badRequest('invalid_attachment');
      await tx`UPDATE uploads SET conversation_id = ${conversationId}
                WHERE id = ANY(${attachmentIds}::uuid[]) AND conversation_id IS NULL`;
    }

    const allowed = referenceIds.length
      ? referenceIds
      : (await tx<{ id: string }[]>`SELECT id FROM files WHERE status = 'analysed' AND deleted_at IS NULL`).map((r) => r.id);

    const run = (await tx`
      INSERT INTO runs (conversation_id, user_id, status, selected_file_ids, allowed_file_ids, attachment_ids,
                        tier_override, cost_cap_usd)
      VALUES (${conversationId}, ${userId}, 'queued', ${referenceIds}::uuid[], ${allowed}::uuid[], ${attachmentIds}::uuid[],
              ${tierOverride}, ${env.runCostCapUsd()}::numeric)
      RETURNING *`)[0];

    const parts = [{ type: 'text', text: input.text }];
    const message = (await tx`
      INSERT INTO messages (conversation_id, run_id, role, content, parts, attachment_ids, reference_ids)
      VALUES (${conversationId}, ${run.id as string}, 'user', ${input.text}, ${json(parts)},
              ${attachmentIds}::uuid[], ${referenceIds}::uuid[])
      RETURNING *`)[0];

    const prior = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${conversationId} AND role = 'user'`;
    if (prior[0].n === 1) {
      await tx`UPDATE conversations SET title = ${titleFrom(input.text)}, updated_at = now() WHERE id = ${conversationId}`;
    } else {
      await tx`UPDATE conversations SET updated_at = now() WHERE id = ${conversationId}`;
    }

    await enqueueJob(tx, 'run_agent', { run_id: run.id }, { dedupeKey: `run:${run.id}` });
    return { message, run };
  });
}
