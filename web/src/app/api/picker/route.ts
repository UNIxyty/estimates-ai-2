import { sql } from '@/lib/db';
import { json, route } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { FILE_TAGS, pickerGroups } from '@/lib/knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "/" picker: analysed files grouped by tag. With `?all=1` the groups also list files that are still being
 * analysed or failed (each file then carries `status`), so the picker can show them disabled with a status dot.
 */
export const GET = route(async (req) => {
  await requireUser(req);
  if (new URL(req.url).searchParams.get('all') !== '1') return json(await pickerGroups());
  const rows = await sql<{ id: string; original_name: string; tag: string; ext: string; language: string | null; status: string; analysed_at: Date | null }[]>`
    SELECT id, original_name, tag, ext, language, status, analysed_at FROM files
     WHERE deleted_at IS NULL ORDER BY tag, original_name`;
  return json({
    groups: FILE_TAGS.map((tag) => ({ tag, files: rows.filter((r) => r.tag === tag) })).filter((g) => g.files.length > 0),
  });
});
