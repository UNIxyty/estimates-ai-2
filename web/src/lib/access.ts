import { sql, type Q } from './db';
import { notFound, forbidden } from './http';
import type { SessionUser } from './auth/session';

/**
 * Ownership lookups. Anything owned by another user is reported as 404 (never 403) so ids of other
 * people's conversations cannot be probed.
 */
export async function ownedConversation(userId: string, id: string, q: Q = sql) {
  const rows = await q`SELECT * FROM conversations WHERE id = ${id} AND user_id = ${userId}`;
  if (!rows[0]) throw notFound();
  return rows[0] as Record<string, unknown> & { id: string; title: string; user_id: string };
}

export async function ownedRun(userId: string, id: string, q: Q = sql) {
  const rows = await q`SELECT r.* FROM runs r JOIN conversations c ON c.id = r.conversation_id
                        WHERE r.id = ${id} AND c.user_id = ${userId}`;
  if (!rows[0]) throw notFound();
  return rows[0] as Record<string, unknown> & { id: string; status: string; conversation_id: string };
}

export async function ownedDocument(userId: string, id: string, q: Q = sql) {
  const rows = await q`SELECT d.* FROM documents d JOIN conversations c ON c.id = d.conversation_id
                        WHERE d.id = ${id} AND c.user_id = ${userId}`;
  if (!rows[0]) throw notFound();
  return rows[0] as Record<string, unknown> & { id: string; name: string; stored_path: string };
}

export async function ownedCard(userId: string, id: string, q: Q = sql) {
  const rows = await q`SELECT k.* FROM cards k JOIN conversations c ON c.id = k.conversation_id
                        WHERE k.id = ${id} AND c.user_id = ${userId}`;
  if (!rows[0]) throw notFound();
  return rows[0] as Record<string, unknown> & { id: string; run_id: string; kind: string; status: string };
}

/** Knowledge files are workspace-wide: any active user may read. */
export async function visibleFile(id: string, q: Q = sql) {
  const rows = await q`SELECT * FROM files WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows[0]) throw notFound();
  return rows[0] as Record<string, unknown> & {
    id: string; uploaded_by: string | null; original_name: string; ext: string; stored_path: string; status: string; tag: string;
  };
}

/** Deleting a file / editing its overrides: the uploader or an admin. */
export function assertCanEditFile(user: SessionUser, file: { uploaded_by: string | null }) {
  if (user.role === 'admin') return;
  if (file.uploaded_by && file.uploaded_by === user.id) return;
  throw forbidden();
}
