import { sql } from '@/lib/db';
import { notFound } from '@/lib/http';

/** A chat attachment owned by the user (another user's upload is reported as 404). */
export async function ownedUpload(userId: string, id: string) {
  const rows = await sql`SELECT * FROM uploads WHERE id = ${id} AND user_id = ${userId}`;
  if (!rows[0]) throw notFound();
  return rows[0] as Record<string, unknown> & { id: string; original_name: string; ext: string; stored_path: string };
}
