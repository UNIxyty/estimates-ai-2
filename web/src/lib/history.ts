import { sql } from './db';

/**
 * History list (design/history.dc.html, DESIGN.md §4.8): one row per conversation owned by the user.
 * Status is derived from real data:
 *   - "Sent": an email with one of the conversation's documents was delivered (email_sends.status = 'done');
 *   - "Done": the conversation produced a document and no run is still active;
 *   - "In progress": otherwise (no output file yet, or a run is still going).
 */
export type HistoryStatus = 'In progress' | 'Done' | 'Sent';

export interface HistoryRow {
  id: string;
  title: string;
  /** Names of the files attached in the conversation (the blank / work list), newest first. */
  attachments: string[];
  messages: number;
  created_at: string;
  last_activity_at: string;
  status: HistoryStatus;
  language: string | null;
  cost_usd: number;
  /** Latest output document, if any. */
  document: { id: string; name: string; language: string | null; created_at: string } | null;
  sent_at: string | null;
  active_run: boolean;
}

const ACTIVE = ['queued', 'running', 'waiting', 'paused_cost'];

export async function listHistory(userId: string): Promise<HistoryRow[]> {
  const rows = await sql`
    SELECT c.id, c.title, c.created_at,
           GREATEST(c.updated_at, COALESCE(m.last_message_at, c.updated_at)) AS last_activity_at,
           COALESCE(m.messages, 0) AS messages,
           COALESCE(u.cost_usd, 0)::float8 AS cost_usd,
           d.id AS doc_id, d.name AS doc_name, d.language AS doc_language, d.created_at AS doc_created_at,
           e.sent_at,
           EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.status = ANY(${ACTIVE}::text[])) AS active_run,
           COALESCE((SELECT array_agg(up.original_name ORDER BY up.created_at DESC) FROM uploads up
                      WHERE up.conversation_id = c.id), '{}') AS attachments
      FROM conversations c
      LEFT JOIN LATERAL (SELECT max(created_at) AS last_message_at, count(*)::int AS messages
                           FROM messages WHERE conversation_id = c.id) m ON true
      LEFT JOIN LATERAL (SELECT sum(cost_usd) AS cost_usd FROM usage WHERE conversation_id = c.id) u ON true
      LEFT JOIN LATERAL (SELECT id, name, language, created_at FROM documents
                          WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) d ON true
      LEFT JOIN LATERAL (SELECT max(es.updated_at) AS sent_at FROM email_sends es JOIN documents dd ON dd.id = es.document_id
                          WHERE dd.conversation_id = c.id AND es.status = 'done') e ON true
     WHERE c.user_id = ${userId} AND c.archived_at IS NULL
     ORDER BY last_activity_at DESC
     LIMIT 1000`;
  return rows.map((r) => {
    const document = r.doc_id ? { id: r.doc_id, name: r.doc_name, language: r.doc_language ?? null, created_at: r.doc_created_at } : null;
    const status: HistoryStatus = r.sent_at ? 'Sent' : document && !r.active_run ? 'Done' : 'In progress';
    return {
      id: r.id,
      title: r.title,
      attachments: r.attachments ?? [],
      messages: r.messages,
      created_at: r.created_at,
      last_activity_at: r.last_activity_at,
      status,
      language: document?.language ? String(document.language).toUpperCase() : null,
      cost_usd: Number(r.cost_usd) || 0,
      document,
      sent_at: r.sent_at ?? null,
      active_run: !!r.active_run,
    } as HistoryRow;
  });
}
