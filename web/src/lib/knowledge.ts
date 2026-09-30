import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { json, sql } from './db';
import { badRequest, HttpError, notFound } from './http';
import { enqueueJob } from './jobs';
import { KNOWLEDGE_EXTS, MIME, checkUploadFile, extOf, removeDir, saveFile } from './storage';
import { assertCanEditFile, visibleFile } from './access';
import type { SessionUser } from './auth/session';
import { workerPoke } from './worker';

export const FILE_TAGS = ['reference_estimate', 'hourly_norms', 'price_list', 'other'] as const;
export const tagSchema = z.enum(FILE_TAGS);

const FILE_LIST_COLS = () => sql`
  f.id, f.original_name, f.ext, f.size_bytes, f.tag, f.status, f.progress, f.fail_reason, f.language,
  f.summary, f.created_at, f.updated_at, f.analysed_at, f.uploaded_by, u.name AS uploaded_by_name`;

export async function listFiles() {
  return sql`SELECT ${FILE_LIST_COLS()} FROM files f LEFT JOIN users u ON u.id = f.uploaded_by
              WHERE f.deleted_at IS NULL ORDER BY f.created_at DESC`;
}

export async function uploadKnowledgeFile(user: SessionUser, form: FormData) {
  const file = checkUploadFile(form.get('file'), KNOWLEDGE_EXTS);
  const tag = tagSchema.safeParse(form.get('tag') ?? 'other');
  if (!tag.success) throw badRequest('invalid_tag', { allowed: FILE_TAGS });
  const id = randomUUID();
  const ext = extOf(file.name);
  const saved = await saveFile(`knowledge/${id}/original.${ext}`, file);
  return sql.begin(async (tx) => {
    const row = (await tx`
      INSERT INTO files (id, uploaded_by, original_name, ext, mime, size_bytes, sha256, stored_path, tag, status, progress)
      VALUES (${id}, ${user.id}, ${file.name.slice(0, 500)}, ${ext}, ${file.type || MIME[ext] || null}, ${saved.size},
              ${saved.sha256}, ${saved.absPath}, ${tag.data}, 'queued', 0)
      RETURNING *`)[0];
    await enqueueJob(tx, 'ingest_file', { file_id: id }, { dedupeKey: `ingest:${id}` });
    return row;
  });
}

export async function fileDetail(viewerId: string, id: string) {
  const f = (await sql`SELECT f.*, u.name AS uploaded_by_name FROM files f LEFT JOIN users u ON u.id = f.uploaded_by
                        WHERE f.id = ${id} AND f.deleted_at IS NULL`)[0];
  if (!f) throw notFound();
  const [sheets, sections, logic, notes, counts, usedIn] = await Promise.all([
    sql`SELECT * FROM file_sheets WHERE file_id = ${id} ORDER BY idx`,
    sql`SELECT * FROM file_sections WHERE file_id = ${id} ORDER BY sheet_id, ord, row_start`,
    sql`SELECT l.*, COALESCE(l.override_sentence, l.sentence) AS effective_sentence,
               COALESCE(l.override_numbers, l.numbers) AS effective_numbers,
               (l.override_sentence IS NOT NULL OR l.override_numbers IS NOT NULL) AS edited,
               u.name AS overridden_by_name
          FROM file_logic l LEFT JOIN users u ON u.id = l.overridden_by
         WHERE l.file_id = ${id} ORDER BY l.sheet_name NULLS FIRST, l.ord`,
    sql`SELECT n.*, CASE WHEN n.source = 'user' THEN 'Your note' WHEN n.edited THEN 'Edited' ELSE NULL END AS label,
               u.name AS created_by_name
          FROM agent_notes n LEFT JOIN users u ON u.id = n.created_by
         WHERE n.file_id = ${id} ORDER BY n.ord, n.created_at`,
    sql`SELECT (SELECT count(*)::int FROM price_items WHERE file_id = ${id}) AS price_items,
               (SELECT count(*)::int FROM price_items WHERE file_id = ${id} AND override IS NOT NULL) AS price_items_edited,
               (SELECT count(*)::int FROM norms WHERE file_id = ${id}) AS norms,
               (SELECT count(*)::int FROM file_logic WHERE file_id = ${id}) AS logic,
               (SELECT count(*)::int FROM agent_notes WHERE file_id = ${id}) AS notes,
               (SELECT count(*)::int FROM file_sheets WHERE file_id = ${id}) AS sheets,
               (SELECT count(*)::int FROM file_sections WHERE file_id = ${id}) AS sections`,
    usedInFor(viewerId, id),
  ]);
  return { file: f, sheets, sections, logic, notes, counts: counts[0], usedIn };
}

/** Only the viewer's own conversations are listed with titles; other people's are just counted. */
export async function usedInFor(viewerId: string, fileId: string) {
  const rows = await sql<{ conversation_id: string; title: string; user_id: string; rows_used: number; last_used: Date }[]>`
    SELECT fu.conversation_id, c.title, c.user_id, sum(fu.rows_used)::int AS rows_used, max(fu.created_at) AS last_used
      FROM file_usage fu JOIN conversations c ON c.id = fu.conversation_id
     WHERE fu.file_id = ${fileId}
     GROUP BY fu.conversation_id, c.title, c.user_id
     ORDER BY max(fu.created_at) DESC`;
  const mine = rows.filter((r) => r.user_id === viewerId).map(({ user_id: _u, ...r }) => r);
  return { total: rows.length, mine, others: rows.length - mine.length };
}

const PRICE_OVERRIDE_FIELDS = z
  .object({
    item_text: z.string().max(2000),
    unit: z.string().max(50).nullable(),
    qty: z.number().nullable(),
    norm_h_per_unit: z.number().nullable(),
    unit_labour: z.number().nullable(),
    unit_material: z.number().nullable(),
    hourly_rate: z.number().nullable(),
    category: z.string().max(200).nullable(),
  })
  .partial()
  .strict();
const NORM_OVERRIDE_FIELDS = z
  .object({
    item_text: z.string().max(2000),
    unit: z.string().max(50).nullable(),
    hours: z.number().min(0),
    category: z.string().max(200).nullable(),
  })
  .partial()
  .strict();

export const itemPatchSchema = z.object({
  override: z.record(z.unknown()).nullable().optional(),
  reset: z.boolean().optional(),
});

export async function listItems(fileId: string, opts: { offset: number; limit: number; q: string; kind?: string | null }) {
  const file = await visibleFile(fileId);
  const kind = opts.kind === 'norms' || opts.kind === 'price_items' ? opts.kind : file.tag === 'hourly_norms' ? 'norms' : 'price_items';
  const like = opts.q ? `%${opts.q.replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;
  if (kind === 'norms') {
    const [items, total] = await Promise.all([
      sql`SELECT id, file_id, sheet_name, row_idx, category, item_text, unit, unit_norm, hours, specificity, params, attrs,
                 extracted_by, override, overridden_by, overridden_at,
                 (to_jsonb(n) - 'embedding' - 'override') || COALESCE(override, '{}'::jsonb) AS effective,
                 (override IS NOT NULL) AS edited
            FROM norms n WHERE file_id = ${fileId} AND (${like}::text IS NULL OR item_text ILIKE ${like})
           ORDER BY sheet_name NULLS FIRST, row_idx NULLS LAST, item_text
           OFFSET ${opts.offset} LIMIT ${opts.limit}`,
      sql<{ n: number }[]>`SELECT count(*)::int AS n FROM norms WHERE file_id = ${fileId}
                             AND (${like}::text IS NULL OR item_text ILIKE ${like})`,
    ]);
    return { kind, total: total[0].n, offset: opts.offset, limit: opts.limit, items };
  }
  const [items, total] = await Promise.all([
    sql`SELECT id, file_id, sheet_name, row_idx, section_title, item_text, unit, unit_norm, qty, norm_h_per_unit,
               unit_labour, unit_material, total_labour, total_material, hourly_rate, currency, attrs, category,
               source_cells, extracted_by, override, overridden_by, overridden_at,
               (to_jsonb(p) - 'embedding' - 'override') || COALESCE(override, '{}'::jsonb) AS effective,
               (override IS NOT NULL) AS edited
          FROM price_items p WHERE file_id = ${fileId} AND (${like}::text IS NULL OR item_text ILIKE ${like})
         ORDER BY sheet_name, row_idx
         OFFSET ${opts.offset} LIMIT ${opts.limit}`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM price_items WHERE file_id = ${fileId}
                           AND (${like}::text IS NULL OR item_text ILIKE ${like})`,
  ]);
  return { kind, total: total[0].n, offset: opts.offset, limit: opts.limit, items };
}

/** Stores a user override (merged over earlier overrides); `reset: true` clears it. */
export async function patchItem(user: SessionUser, fileId: string, itemId: string, body: z.infer<typeof itemPatchSchema>) {
  const file = await visibleFile(fileId);
  assertCanEditFile(user, file);
  const reset = body.reset === true || body.override === null;
  const isPrice = (await sql`SELECT 1 FROM price_items WHERE id = ${itemId} AND file_id = ${fileId}`).length > 0;
  const isNorm = !isPrice && (await sql`SELECT 1 FROM norms WHERE id = ${itemId} AND file_id = ${fileId}`).length > 0;
  if (!isPrice && !isNorm) throw notFound();
  let row;
  if (reset) {
    row = isPrice
      ? (await sql`UPDATE price_items SET override = NULL, overridden_by = NULL, overridden_at = NULL
                    WHERE id = ${itemId} RETURNING id, override`)[0]
      : (await sql`UPDATE norms SET override = NULL, overridden_by = NULL, overridden_at = NULL
                    WHERE id = ${itemId} RETURNING id, override`)[0];
  } else {
    const ov = (isPrice ? PRICE_OVERRIDE_FIELDS : NORM_OVERRIDE_FIELDS).parse(body.override ?? {});
    if (Object.keys(ov).length === 0) throw badRequest('empty_override');
    row = isPrice
      ? (await sql`UPDATE price_items SET override = COALESCE(override, '{}'::jsonb) || ${json(ov)},
                          overridden_by = ${user.id}, overridden_at = now()
                    WHERE id = ${itemId} RETURNING id, override`)[0]
      : (await sql`UPDATE norms SET override = COALESCE(override, '{}'::jsonb) || ${json(ov)},
                          overridden_by = ${user.id}, overridden_at = now()
                    WHERE id = ${itemId} RETURNING id, override`)[0];
  }
  workerPoke(`/internal/files/${fileId}/recompute`, { item_id: itemId });
  return { item: row };
}

export const logicPatchSchema = z
  .object({
    override_sentence: z.string().trim().max(5000).nullable().optional(),
    override_numbers: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

export async function patchLogic(user: SessionUser, fileId: string, logicId: string, body: z.infer<typeof logicPatchSchema>) {
  const file = await visibleFile(fileId);
  assertCanEditFile(user, file);
  const cur = (await sql`SELECT id FROM file_logic WHERE id = ${logicId} AND file_id = ${fileId}`)[0];
  if (!cur) throw notFound();
  const sentence = body.override_sentence === undefined ? undefined : body.override_sentence || null;
  const numbers = body.override_numbers === undefined ? undefined : body.override_numbers;
  const row = (await sql`
    UPDATE file_logic SET
      override_sentence = CASE WHEN ${sentence === undefined} THEN override_sentence ELSE ${sentence ?? null}::text END,
      override_numbers  = CASE WHEN ${numbers === undefined} THEN override_numbers ELSE ${numbers ? json(numbers) : null}::jsonb END,
      overridden_by = ${user.id}, overridden_at = now()
    WHERE id = ${logicId}
    RETURNING *, COALESCE(override_sentence, sentence) AS effective_sentence,
              (override_sentence IS NOT NULL OR override_numbers IS NOT NULL) AS edited`)[0];
  workerPoke(`/internal/files/${fileId}/recompute`, { logic_id: logicId });
  return { logic: row };
}

export const noteSchema = z.object({ text: z.string().trim().min(1).max(5000) });

export async function addNote(user: SessionUser, fileId: string, text: string) {
  await visibleFile(fileId);
  const row = (await sql`
    INSERT INTO agent_notes (file_id, ord, text, source, created_by)
    VALUES (${fileId}, COALESCE((SELECT max(ord) + 1 FROM agent_notes WHERE file_id = ${fileId}), 0), ${text}, 'user', ${user.id})
    RETURNING *, 'Your note' AS label`)[0];
  return { note: row };
}

/** Note author, the file's uploader, or an admin may edit/delete a note. */
async function editableNote(user: SessionUser, fileId: string, noteId: string) {
  const file = await visibleFile(fileId);
  const note = (await sql<{ id: string; created_by: string | null; source: string }[]>`
    SELECT id, created_by, source FROM agent_notes WHERE id = ${noteId} AND file_id = ${fileId}`)[0];
  if (!note) throw notFound();
  if (!(note.source === 'user' && note.created_by === user.id)) assertCanEditFile(user, file);
  return note;
}

export async function editNote(user: SessionUser, fileId: string, noteId: string, text: string) {
  await editableNote(user, fileId, noteId);
  const row = (await sql`
    UPDATE agent_notes SET text = ${text}, updated_at = now(), edited = (source = 'model')
     WHERE id = ${noteId}
    RETURNING *, CASE WHEN source = 'user' THEN 'Your note' WHEN edited THEN 'Edited' ELSE NULL END AS label`)[0];
  return { note: row };
}

export async function deleteNote(user: SessionUser, fileId: string, noteId: string) {
  await editableNote(user, fileId, noteId);
  await sql`DELETE FROM agent_notes WHERE id = ${noteId}`;
  return { ok: true };
}

export async function forgetPreview(fileId: string) {
  await visibleFile(fileId);
  const r = (await sql`
    SELECT (SELECT count(*)::int FROM price_items WHERE file_id = ${fileId}) AS price_items,
           (SELECT count(*)::int FROM norms WHERE file_id = ${fileId}) AS norms,
           (SELECT count(*)::int FROM agent_notes WHERE file_id = ${fileId}) AS notes,
           (SELECT count(*)::int FROM file_logic WHERE file_id = ${fileId}) AS logic,
           (SELECT count(*)::int FROM file_sheets WHERE file_id = ${fileId}) AS sheets,
           ((SELECT count(*)::int FROM price_items WHERE file_id = ${fileId} AND embedding IS NOT NULL) +
            (SELECT count(*)::int FROM norms WHERE file_id = ${fileId} AND embedding IS NOT NULL)) AS embeddings,
           (SELECT count(DISTINCT conversation_id)::int FROM file_usage WHERE file_id = ${fileId}) AS used_in`)[0];
  return r;
}

/** Removes the file row (cascades to records + embeddings) and its directory on disk. */
export async function deleteFile(user: SessionUser, fileId: string) {
  const file = await visibleFile(fileId);
  assertCanEditFile(user, file);
  await sql.begin(async (tx) => {
    await tx`UPDATE jobs SET status = 'cancelled', finished_at = now()
              WHERE dedupe_key = ${`ingest:${fileId}`} AND status = 'queued'`;
    await tx`DELETE FROM files WHERE id = ${fileId}`;
  });
  await removeDir(`knowledge/${fileId}`).catch((e) => console.error('[files] rm failed', e));
  return { ok: true };
}

export async function reanalyse(user: SessionUser, fileId: string) {
  const file = await visibleFile(fileId);
  assertCanEditFile(user, file);
  return sql.begin(async (tx) => {
    const jobId = await enqueueJob(tx, 'ingest_file', { file_id: fileId, reanalyse: true }, { dedupeKey: `ingest:${fileId}` });
    if (jobId === null) throw new HttpError(409, 'already_analysing');
    const row = (await tx`UPDATE files SET status = 'queued', progress = 0, fail_reason = NULL, updated_at = now()
                           WHERE id = ${fileId} RETURNING *`)[0];
    return { file: row, job_id: jobId };
  });
}

export async function setTag(user: SessionUser, fileId: string, tag: z.infer<typeof tagSchema>) {
  const file = await visibleFile(fileId);
  assertCanEditFile(user, file);
  const row = (await sql`UPDATE files SET tag = ${tag}, updated_at = now() WHERE id = ${fileId} RETURNING *`)[0];
  return { file: row };
}

export async function knowledgeStatus() {
  const [unlocked, byStatus, byTag, analysedByTag] = await Promise.all([
    sql<{ ok: boolean }[]>`SELECT chat_unlocked() AS ok`,
    sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM files WHERE deleted_at IS NULL GROUP BY status`,
    sql<{ tag: string; n: number }[]>`SELECT tag, count(*)::int AS n FROM files WHERE deleted_at IS NULL GROUP BY tag`,
    sql<{ tag: string; n: number }[]>`SELECT tag, count(*)::int AS n FROM files WHERE deleted_at IS NULL AND status = 'analysed' GROUP BY tag`,
  ]);
  const toObj = (rows: { n: number }[], key: 'status' | 'tag') =>
    Object.fromEntries(rows.map((r) => [(r as unknown as Record<string, string>)[key], r.n]));
  return {
    chatUnlocked: unlocked[0].ok,
    counts: {
      byStatus: toObj(byStatus, 'status'),
      byTag: toObj(byTag, 'tag'),
      analysedByTag: toObj(analysedByTag, 'tag'),
      total: byStatus.reduce((a, r) => a + r.n, 0),
    },
  };
}

export async function pickerGroups() {
  const rows = await sql<{ id: string; original_name: string; tag: string; ext: string; language: string | null; analysed_at: Date | null; summary: unknown }[]>`
    SELECT id, original_name, tag, ext, language, analysed_at, summary FROM files
     WHERE status = 'analysed' AND deleted_at IS NULL ORDER BY tag, original_name`;
  return {
    groups: FILE_TAGS.map((tag) => ({ tag, files: rows.filter((r) => r.tag === tag) })).filter((g) => g.files.length > 0),
  };
}
