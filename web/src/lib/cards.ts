import { z } from 'zod';
import { json, sql, type Tx } from './db';
import { env, PERMISSION_CARD_MINUTES } from './env';
import { badRequest, isUuid } from './http';
import { enqueueJob } from './jobs';
import { appendRunEvent } from './runEvents';
import { ownedCard } from './access';

export const CARD_ACTIONS = [
  'allow', 'deny', 'undo', 'ask_again', 'generate', 'change', 'use_reference', 'answer', 'retry', 'continue', 'stop',
] as const;
export type CardAction = (typeof CARD_ACTIONS)[number];

const ACTIONS_BY_KIND: Record<string, readonly CardAction[]> = {
  permission: ['allow', 'deny', 'undo', 'ask_again'],
  structure: ['generate', 'change', 'use_reference'],
  clarify: ['answer'],
  email: ['retry'],
  cost_cap: ['continue', 'stop'],
  document: [],
  web_prices: [],
};

export const decisionSchema = z.object({
  action: z.enum(CARD_ACTIONS),
  data: z.record(z.unknown()).optional().default({}),
});

type Card = Record<string, unknown> & {
  id: string;
  run_id: string;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
};

export interface DecisionResult {
  status: number;
  body: { card: Card; error?: string };
}

const resumeKey = (cardId: string) => `resume:${cardId}`;

/**
 * Applies a card decision. Every transition is a state-guarded UPDATE (… WHERE status = expected),
 * inside a transaction that first locks the run row, so a repeated or concurrent click matches zero
 * rows and returns the current card with 200 and no second job/event.
 */
export async function decideCard(
  userId: string,
  cardId: string,
  input: { action: CardAction; data?: Record<string, unknown> },
): Promise<DecisionResult> {
  const card0 = await ownedCard(userId, cardId);
  const { action } = input;
  const data = input.data ?? {};
  if (!(ACTIONS_BY_KIND[card0.kind] ?? []).includes(action)) {
    throw badRequest('invalid_action', { kind: card0.kind, allowed: ACTIONS_BY_KIND[card0.kind] ?? [] });
  }

  // Validate action data up-front (outside the transaction).
  let decisionData: Record<string, unknown> = {};
  if (action === 'change') {
    const instructions = typeof data.instructions === 'string' ? data.instructions.trim() : '';
    if (!instructions) throw badRequest('instructions_required');
    decisionData = { instructions: instructions.slice(0, 5000) };
  } else if (action === 'use_reference') {
    const fileId = data.file_id;
    if (!isUuid(fileId)) throw badRequest('file_id_required');
    const f = await sql`SELECT id FROM files WHERE id = ${fileId} AND status = 'analysed' AND deleted_at IS NULL`;
    if (!f[0]) throw badRequest('file_not_analysed');
    decisionData = { file_id: fileId };
  } else if (action === 'answer') {
    if (data.answers === null || typeof data.answers !== 'object' || Array.isArray(data.answers)) {
      throw badRequest('answers_required');
    }
    decisionData = { answers: data.answers };
  }

  return sql.begin(async (tx) => {
    await tx`SELECT id FROM runs WHERE id = ${card0.run_id} FOR UPDATE`;
    const current = async (): Promise<Card> =>
      (await tx<Card[]>`SELECT * FROM cards WHERE id = ${cardId}`)[0];
    const emit = async (card: Card) => {
      await appendRunEvent(tx, card.run_id, 'card.updated', { card });
    };
    const decide = async (from: string[], to: string, extraWhere: 'none' | 'not_expired' = 'none') => {
      const decision = json({ action, data: decisionData });
      const rows =
        extraWhere === 'not_expired'
          ? await tx<Card[]>`
              UPDATE cards SET status = ${to}, decision = ${decision}, decided_by = ${userId}, decided_at = now(),
                               updated_at = now(), version = version + 1
               WHERE id = ${cardId} AND status = ANY(${from}::text[]) AND (expires_at IS NULL OR expires_at > now())
               RETURNING *`
          : await tx<Card[]>`
              UPDATE cards SET status = ${to}, decision = ${decision}, decided_by = ${userId}, decided_at = now(),
                               updated_at = now(), version = version + 1
               WHERE id = ${cardId} AND status = ANY(${from}::text[])
               RETURNING *`;
      return rows[0] ?? null;
    };
    const resume = (delaySeconds = 0) =>
      enqueueJob(tx, 'resume_run', { run_id: card0.run_id, card_id: cardId }, { dedupeKey: resumeKey(cardId), delaySeconds });

    switch (action) {
      case 'allow':
      case 'deny': {
        const updated = await decide(['pending'], action === 'allow' ? 'approved' : 'denied', 'not_expired');
        if (!updated) {
          // Pending but past expiry: mark expired (so every tab sees it) and refuse.
          const exp = await tx<Card[]>`
            UPDATE cards SET status = 'expired', updated_at = now(), version = version + 1
             WHERE id = ${cardId} AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= now()
             RETURNING *`;
          if (exp[0]) {
            await emit(exp[0]);
            return { status: 409, body: { error: 'expired', card: exp[0] } };
          }
          const cur = await current();
          if (cur.status === 'expired') return { status: 409, body: { error: 'expired', card: cur } };
          return { status: 200, body: { card: cur } };
        }
        const fileId = updated.payload?.file_id;
        if (isUuid(fileId)) {
          if (action === 'allow') {
            await tx`UPDATE runs SET allowed_file_ids = CASE WHEN ${fileId}::uuid = ANY(allowed_file_ids)
                       THEN allowed_file_ids ELSE allowed_file_ids || ${fileId}::uuid END WHERE id = ${card0.run_id}`;
          } else {
            await tx`UPDATE runs SET denied_file_ids = CASE WHEN ${fileId}::uuid = ANY(denied_file_ids)
                       THEN denied_file_ids ELSE denied_file_ids || ${fileId}::uuid END WHERE id = ${card0.run_id}`;
          }
        }
        await resume(env.undoSeconds());
        await emit(updated);
        return { status: 200, body: { card: updated } };
      }

      case 'undo': {
        const rows = await tx<(Card & { in_window: boolean })[]>`
          SELECT *, (decided_at IS NOT NULL AND decided_at > now() - make_interval(secs => ${env.undoSeconds()}::float8)) AS in_window
            FROM cards WHERE id = ${cardId} FOR UPDATE`;
        const { in_window, ...cur } = rows[0];
        if (cur.status !== 'approved' && cur.status !== 'denied') return { status: 200, body: { card: cur as Card } };
        if (!in_window) return { status: 409, body: { error: 'too_late', card: cur as Card } };
        const cancelled = await tx`
          UPDATE jobs SET status = 'cancelled', finished_at = now()
           WHERE dedupe_key = ${resumeKey(cardId)} AND status = 'queued' RETURNING id`;
        if (!cancelled[0]) return { status: 409, body: { error: 'too_late', card: cur as Card } };
        const reverted = await tx<Card[]>`
          UPDATE cards SET status = 'pending', decision = NULL, decided_by = NULL, decided_at = NULL,
                           updated_at = now(), version = version + 1
           WHERE id = ${cardId} AND status = ${cur.status} RETURNING *`;
        const fileId = cur.payload?.file_id;
        if (isUuid(fileId)) {
          if (cur.status === 'approved') {
            await tx`UPDATE runs SET allowed_file_ids = array_remove(allowed_file_ids, ${fileId}::uuid) WHERE id = ${card0.run_id}`;
          } else {
            await tx`UPDATE runs SET denied_file_ids = array_remove(denied_file_ids, ${fileId}::uuid) WHERE id = ${card0.run_id}`;
          }
        }
        await emit(reverted[0]);
        return { status: 200, body: { card: reverted[0] } };
      }

      case 'ask_again': {
        const rows = await tx<Card[]>`
          UPDATE cards SET status = 'pending', expires_at = now() + make_interval(mins => ${PERMISSION_CARD_MINUTES}),
                           decision = NULL, decided_by = NULL, decided_at = NULL, updated_at = now(), version = version + 1
           WHERE id = ${cardId}
             AND (status = 'expired' OR (status = 'pending' AND expires_at IS NOT NULL AND expires_at < now()))
           RETURNING *`;
        if (!rows[0]) return { status: 200, body: { card: await current() } };
        await emit(rows[0]);
        return { status: 200, body: { card: rows[0] } };
      }

      case 'generate':
      case 'change':
      case 'use_reference': {
        const to = action === 'generate' ? 'generating' : action === 'change' ? 'changed' : 'replaced';
        const updated = await decide(['pending'], to);
        if (!updated) return { status: 200, body: { card: await current() } };
        await resume();
        await emit(updated);
        return { status: 200, body: { card: updated } };
      }

      case 'answer': {
        const updated = await decide(['pending'], 'answered');
        if (!updated) return { status: 200, body: { card: await current() } };
        await resume();
        await emit(updated);
        return { status: 200, body: { card: updated } };
      }

      case 'continue':
      case 'stop': {
        const updated = await decide(['pending'], action === 'continue' ? 'continued' : 'stopped');
        if (!updated) return { status: 200, body: { card: await current() } };
        if (action === 'continue') {
          // "continue raises the run cap by RUN_COST_CAP_USD" — applied here, once, under the state guard.
          await tx`UPDATE runs SET cost_cap_usd = cost_cap_usd + ${env.runCostCapUsd()}::numeric WHERE id = ${card0.run_id}`;
        } else {
          await tx`UPDATE runs SET cancel_requested = true WHERE id = ${card0.run_id}`;
          await tx`SELECT pg_notify('run_cancel', ${card0.run_id})`;
        }
        await resume();
        await emit(updated);
        return { status: 200, body: { card: updated } };
      }

      case 'retry': {
        const updated = await decide(['failed'], 'sending');
        if (!updated) return { status: 200, body: { card: await current() } };
        let emailSendId = updated.payload?.email_send_id;
        if (!isUuid(emailSendId)) {
          const es = await tx<{ id: string }[]>`SELECT id FROM email_sends WHERE card_id = ${cardId} ORDER BY created_at DESC LIMIT 1`;
          emailSendId = es[0]?.id;
        }
        if (isUuid(emailSendId)) {
          await tx`UPDATE email_sends SET status = 'queued', error = NULL, updated_at = now() WHERE id = ${emailSendId}`;
          await enqueueJob(tx, 'send_email', { email_send_id: emailSendId }, { dedupeKey: `email:${emailSendId}` });
        }
        await emit(updated);
        return { status: 200, body: { card: updated } };
      }
    }
    return { status: 400, body: { error: 'invalid_action', card: await current() } };
  }) as Promise<DecisionResult>;
}
