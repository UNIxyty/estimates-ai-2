import { sql } from './db';
import { ownedConversation } from './access';
import { ACTIVE_RUN_STATUSES } from './chat';

export async function listConversations(userId: string, q: string) {
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;
  return sql`
    SELECT c.id, c.title, c.created_at, c.updated_at,
           GREATEST(c.updated_at, COALESCE(m.last_message_at, c.updated_at)) AS last_activity_at,
           COALESCE(u.cost_usd, 0)::float8 AS cost_usd,
           COALESCE(m.messages, 0) AS messages,
           (SELECT r.status FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC LIMIT 1) AS last_run_status,
           (SELECT d.language FROM documents d WHERE d.conversation_id = c.id ORDER BY d.created_at DESC LIMIT 1) AS language
      FROM conversations c
      LEFT JOIN LATERAL (SELECT max(created_at) AS last_message_at, count(*)::int AS messages
                           FROM messages WHERE conversation_id = c.id) m ON true
      LEFT JOIN LATERAL (SELECT sum(cost_usd) AS cost_usd FROM usage WHERE conversation_id = c.id) u ON true
     WHERE c.user_id = ${userId} AND c.archived_at IS NULL
       AND (${like}::text IS NULL OR c.title ILIKE ${like}
            OR EXISTS (SELECT 1 FROM messages mm WHERE mm.conversation_id = c.id AND mm.content ILIKE ${like}))
     ORDER BY last_activity_at DESC
     LIMIT 200`;
}

export async function conversationDetail(userId: string, id: string) {
  const conversation = await ownedConversation(userId, id);
  const [messages, cards, documents, cost, activeRun, lastRun, runs, uploads, references, stepEvents] = await Promise.all([
    sql`SELECT * FROM messages WHERE conversation_id = ${id} ORDER BY created_at, id`,
    sql`SELECT * FROM cards WHERE conversation_id = ${id} ORDER BY created_at, id`,
    sql`SELECT id, run_id, conversation_id, name, mode, language, currency, totals, version, template_file_id,
               source_upload_id, created_at, updated_at
          FROM documents WHERE conversation_id = ${id} ORDER BY created_at`,
    sql<{ cost: number }[]>`SELECT COALESCE(sum(cost_usd), 0)::float8 AS cost FROM usage WHERE conversation_id = ${id}`,
    sql`SELECT r.*, (SELECT COALESCE(max(seq), 0) FROM run_events e WHERE e.run_id = r.id) AS last_seq
          FROM runs r WHERE r.conversation_id = ${id}
           AND r.status = ANY(${ACTIVE_RUN_STATUSES as unknown as string[]}::text[])
         ORDER BY r.created_at DESC`,
    sql`SELECT id, status, cost_usd, cost_cap_usd, tier_override, error, created_at, finished_at
          FROM runs WHERE conversation_id = ${id} ORDER BY created_at DESC LIMIT 1`,
    sql`SELECT id, status, kind, error, cost_usd::float8 AS cost_usd, created_at, started_at, finished_at
          FROM runs WHERE conversation_id = ${id} ORDER BY created_at`,
    sql`SELECT id, original_name, ext, size_bytes, created_at FROM uploads WHERE conversation_id = ${id} ORDER BY created_at`,
    sql`SELECT f.id, f.original_name, f.ext, f.tag, f.language FROM files f
         WHERE f.id IN (SELECT unnest(reference_ids) FROM messages WHERE conversation_id = ${id})`,
    // Step events of every run (for the "working steps" block after a reload). Progress events are many,
    // so only the last one per step is returned.
    sql`SELECT e.run_id, e.seq, e.type, e.payload, e.created_at FROM run_events e
          JOIN runs r ON r.id = e.run_id
         WHERE r.conversation_id = ${id} AND e.type IN ('step.started','step.done','step.warn')
        UNION ALL
        SELECT * FROM (
          SELECT DISTINCT ON (e.run_id, e.payload->>'step_id') e.run_id, e.seq, e.type, e.payload, e.created_at
            FROM run_events e JOIN runs r ON r.id = e.run_id
           WHERE r.conversation_id = ${id} AND e.type = 'step.progress'
           ORDER BY e.run_id, e.payload->>'step_id', e.seq DESC) p
        ORDER BY run_id, seq`,
  ]);
  return {
    conversation,
    messages,
    cards,
    documents,
    total_cost_usd: cost[0].cost,
    active_run: activeRun[0] ?? null, // latest non-terminal run (the UI re-attaches to its stream)
    active_runs: activeRun, // all non-terminal runs (a waiting run can coexist with a newer one)
    last_run: lastRun[0] ?? null,
    // Additive fields for the chat UI:
    runs, // every run of the conversation (status + timing), oldest first
    uploads, // chat attachments (names for the attachment cards above user messages)
    references, // knowledge files picked with "/" in any message
    step_events: stepEvents, // step.* events per run (last progress per step only), replayed into the steps block
  };
}
