import { createHash, randomUUID } from 'node:crypto';
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
  f.summary, f.created_at, f.updated_at, f.analysed_at, f.uploaded_by, u.name AS uploaded_by_name,
  f.pricing_model, f.market, f.client, f.end_client, f.package, f.project,
  jsonb_build_object(
    'price_items', (SELECT count(*)::int FROM price_items p WHERE p.file_id = f.id),
    'price_norms', (SELECT count(*)::int FROM price_items p WHERE p.file_id = f.id AND p.norm_h_per_unit IS NOT NULL),
    'norms', (SELECT count(*)::int FROM norms n WHERE n.file_id = f.id),
    'notes', (SELECT count(*)::int FROM agent_notes a WHERE a.file_id = f.id),
    'sections', (SELECT count(*)::int FROM file_sections s WHERE s.file_id = f.id),
    'used_in', (SELECT count(DISTINCT fu.conversation_id)::int FROM file_usage fu WHERE fu.file_id = f.id),
    -- unit-rate BOQs: item install rates (prelims / contractor items aside) and material supply rates
    'install_rates', (SELECT count(*)::int FROM price_items p WHERE p.file_id = f.id AND p.pricing_model = 'unit_rate'
                        AND p.install_rate IS NOT NULL AND COALESCE(p.package, '') NOT IN ('prelims', 'contractor_items')),
    'supply_rates', (SELECT count(*)::int FROM price_items p WHERE p.file_id = f.id AND p.pricing_model = 'unit_rate'
                       AND p.supply_rate IS NOT NULL)
  ) AS counts`;


/** Server paths stay server-side. */
export function publicFile<T extends Record<string, unknown>>(row: T) {
  const { stored_path: _s, work_path: _w, ...rest } = row;
  return rest;
}

export async function listFiles() {
  return sql`SELECT ${FILE_LIST_COLS()} FROM files f LEFT JOIN users u ON u.id = f.uploaded_by
              WHERE f.deleted_at IS NULL ORDER BY f.created_at DESC`;
}

/**
 * Stores a knowledge file and queues its analysis. A byte-identical file already in the knowledge base is not stored
 * twice: the existing file comes back with duplicate = true.
 */
export async function uploadKnowledgeFile(user: SessionUser, form: FormData): Promise<{ file: Record<string, unknown>; duplicate: boolean }> {
  const file = checkUploadFile(form.get('file'), KNOWLEDGE_EXTS);
  const tag = tagSchema.safeParse(form.get('tag') ?? 'other');
  if (!tag.success) throw badRequest('invalid_tag', { allowed: FILE_TAGS });
  const sha256 = createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex');
  const dup = (await sql`SELECT * FROM files WHERE sha256 = ${sha256} AND deleted_at IS NULL
                          ORDER BY created_at LIMIT 1`)[0];
  if (dup) return { file: publicFile(dup), duplicate: true };
  const id = randomUUID();
  const ext = extOf(file.name);
  const saved = await saveFile(`knowledge/${id}/original.${ext}`, file);
  return sql.begin(async (tx) => {
    const row = (await tx`
      INSERT INTO files (id, uploaded_by, original_name, ext, mime, size_bytes, sha256, stored_path, tag, status, progress)
      VALUES (${id}, ${user.id}, ${file.name.slice(0, 500)}, ${ext}, ${MIME[ext] || file.type || null}, ${saved.size},
              ${saved.sha256}, ${saved.absPath}, ${tag.data}, 'queued', 0)
      RETURNING *`)[0];
    await enqueueJob(tx, 'ingest_file', { file_id: id }, { dedupeKey: `ingest:${id}` });
    return { file: publicFile(row), duplicate: false };
  });
}

export async function fileDetail(viewerId: string, id: string) {
  const f = (await sql`SELECT f.*, u.name AS uploaded_by_name FROM files f LEFT JOIN users u ON u.id = f.uploaded_by
                        WHERE f.id = ${id} AND f.deleted_at IS NULL`)[0];
  if (!f) throw notFound();
  const [sheets, sections, logic, notes, counts, usedIn, analysis] = await Promise.all([
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
               (SELECT count(*)::int FROM file_sections WHERE file_id = ${id}) AS sections,
               (SELECT count(*)::int FROM price_items WHERE file_id = ${id} AND pricing_model = 'unit_rate' AND install_rate IS NOT NULL
                   AND COALESCE(package, '') NOT IN ('prelims', 'contractor_items')) AS install_rates,
               (SELECT count(*)::int FROM price_items WHERE file_id = ${id} AND pricing_model = 'unit_rate' AND supply_rate IS NOT NULL) AS supply_rates`,
    usedInFor(viewerId, id),
    // Model cost of reading this file (all analyses), and the highest tier that was used.
    sql`SELECT COALESCE(sum(cost_usd), 0)::float AS cost_usd, count(*)::int AS calls,
               (array_agg(tier ORDER BY CASE tier WHEN 'advanced' THEN 3 WHEN 'standard' THEN 2 WHEN 'fast' THEN 1 ELSE 0 END DESC))[1] AS tier
          FROM usage WHERE file_id = ${id}`,
  ]);
  return { file: publicFile(f), sheets, sections, logic, notes, counts: counts[0], usedIn, analysis: analysis[0] };
}

/** Only the viewer's own conversations are listed with titles; other people's are just counted. */
export async function usedInFor(viewerId: string, fileId: string) {
  const rows = await sql<{ conversation_id: string; title: string; user_id: string; rows_used: number; last_used: Date; language: string | null }[]>`
    SELECT fu.conversation_id, c.title, c.user_id, sum(fu.rows_used)::int AS rows_used, max(fu.created_at) AS last_used,
           (SELECT d.language FROM documents d WHERE d.conversation_id = fu.conversation_id AND d.language IS NOT NULL
             ORDER BY d.created_at DESC LIMIT 1) AS language
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
/** Unit-rate BOQ rows (Total = Quantity × Rate): the install and material-supply rates per unit, no hours. */
const UNIT_RATE_OVERRIDE_FIELDS = z
  .object({
    item_text: z.string().max(2000),
    unit: z.string().max(50).nullable(),
    qty: z.number().nullable(),
    install_rate: z.number().finite().min(0).nullable(),
    supply_rate: z.number().finite().min(0).nullable(),
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
           ORDER BY (attrs ? 'user_added') DESC, sheet_name NULLS FIRST, row_idx NULLS LAST, item_text
           OFFSET ${opts.offset} LIMIT ${opts.limit}`,
      sql<{ n: number }[]>`SELECT count(*)::int AS n FROM norms WHERE file_id = ${fileId}
                             AND (${like}::text IS NULL OR item_text ILIKE ${like})`,
    ]);
    return { kind, total: total[0].n, offset: opts.offset, limit: opts.limit, items };
  }
  // Unit-rate BOQs are also searchable by their rate-card label ("Tray straight · 300 mm").
  const unit = file.pricing_model === 'unit_rate';
  const [items, total] = await Promise.all([
    sql`SELECT id, file_id, sheet_name, row_idx, section_title, item_text, unit, unit_norm, qty, norm_h_per_unit,
               unit_labour, unit_material, total_labour, total_material, hourly_rate, currency, attrs, category,
               source_cells, extracted_by, override, overridden_by, overridden_at,
               pricing_model, install_rate, supply_rate, rate_basis, package, rate_key, flags, section_notes, phase_qty,
               (to_jsonb(p) - 'embedding' - 'override') || COALESCE(override, '{}'::jsonb) AS effective,
               (override IS NOT NULL) AS edited
          FROM price_items p WHERE file_id = ${fileId}
           AND (${like}::text IS NULL OR item_text ILIKE ${like} OR (${unit} AND rate_key ILIKE ${like}))
         ORDER BY (attrs ? 'user_added') DESC, sheet_name, row_idx
         OFFSET ${opts.offset} LIMIT ${opts.limit}`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM price_items WHERE file_id = ${fileId}
                           AND (${like}::text IS NULL OR item_text ILIKE ${like} OR (${unit} AND rate_key ILIKE ${like}))`,
  ]);
  return { kind, total: total[0].n, offset: opts.offset, limit: opts.limit, items };
}

/** Stores a user override (merged over earlier overrides); `reset: true` clears it. */
export async function patchItem(user: SessionUser, fileId: string, itemId: string, body: z.infer<typeof itemPatchSchema>) {
  const file = await visibleFile(fileId);
  assertCanEditFile(user, file);
  const reset = body.reset === true || body.override === null;
  const priceRow = (await sql<{ pricing_model: string }[]>`
    SELECT pricing_model FROM price_items WHERE id = ${itemId} AND file_id = ${fileId}`)[0];
  const isPrice = !!priceRow;
  const isUnitRate = priceRow?.pricing_model === 'unit_rate';
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
    const schema = isUnitRate ? UNIT_RATE_OVERRIDE_FIELDS : isPrice ? PRICE_OVERRIDE_FIELDS : NORM_OVERRIDE_FIELDS;
    const ov: Record<string, unknown> = schema.parse(body.override ?? {});
    if (Object.keys(ov).length === 0) throw badRequest('empty_override');
    // The worker stores a unit-rate row's install / supply rate in unit_labour / unit_material as well; keep the
    // two in step so every reader of the effective row sees the person's rate.
    if (isUnitRate && 'install_rate' in ov) ov.unit_labour = ov.install_rate;
    if (isUnitRate && 'supply_rate' in ov) ov.unit_material = ov.supply_rate;
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

/** Sheet name given to rows a user adds by hand on the "Saved numbers" tab (price items need a sheet + row). */
export const USER_ROWS_SHEET = 'Added by user';

/** Close TS port of the worker's matching.text.normalise_text (lowercase, fold diacritics, unify numbers). */
export function normaliseItemText(s: string): string {
  const fold: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', þ: 'th', ð: 'd', ı: 'i', '²': '2', '³': '3', '×': 'x', '·': ' ', '–': '-', '—': '-' };
  let t = s.toLowerCase().replace(/[øæœßłđþðı²³×·–—]/g, (c) => fold[c] ?? c);
  t = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  t = t.replace(/(?<=\d),(?=\d)/g, '.')
    .replace(/(?<=\d)\s*[x*]\s*(?=\(?\d)/g, 'x')
    .replace(/\bmm\s*(?:\^\s*)?2\b|\bmm\s*kv\b|\bkv\.?\s*mm\b/g, 'mm2')
    .replace(/[^\p{L}\p{N}_\s.%/+-]/gu, ' ')
    .replace(/_+/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/(?<!\d)-|-(?!\d)/g, ' ')
    .replace(/(?<![\p{L}\p{N}_])\/|\/(?![\p{L}\p{N}_])/gu, ' ')
    .replace(/\bmm 2\b/g, 'mm2');
  return t.replace(/\s+/g, ' ').trim();
}

const num = z.number().finite().min(0).nullable().optional();
export const itemCreateSchema = z
  .object({
    item_text: z.string().trim().min(1).max(2000),
    unit: z.string().trim().max(50).nullable().optional(),
    /** price items */
    norm_h_per_unit: num,
    unit_labour: num,
    unit_material: num,
    /** norms (required when the file's saved numbers are norms) */
    hours: num,
  })
  .strict();

/**
 * Adds a row by hand. Price items go on the pseudo-sheet USER_ROWS_SHEET with the next row number and
 * attrs.user_added = true; norms get no sheet/row. Rows have no embedding (exact/text matching only).
 */
export async function addItem(user: SessionUser, fileId: string, body: z.infer<typeof itemCreateSchema>) {
  const file = await visibleFile(fileId);
  assertCanEditFile(user, file);
  if (file.pricing_model === 'unit_rate') throw badRequest('not_supported_for_unit_rate');
  const kind = file.tag === 'hourly_norms' ? 'norms' : 'price_items';
  const unit = body.unit || null;
  const itemNorm = normaliseItemText(body.item_text);
  if (kind === 'norms') {
    if (body.hours == null) throw badRequest('hours_required');
    const row = (await sql`
      INSERT INTO norms (file_id, sheet_name, row_idx, item_text, item_norm, unit, hours, specificity, attrs, extracted_by)
      VALUES (${fileId}, NULL, NULL, ${body.item_text}, ${itemNorm}, ${unit}, ${body.hours}, 'item',
              ${json({ user_added: true, added_by: user.id })}, 'code')
      RETURNING id, file_id, sheet_name, row_idx, item_text, unit, hours, attrs`)[0];
    return { kind, item: row };
  }
  const summary = (file.summary ?? {}) as { currency?: string; hourly_rates?: number[] };
  const rate = Array.isArray(summary.hourly_rates) && summary.hourly_rates.length === 1 ? Number(summary.hourly_rates[0]) : null;
  const labour = body.unit_labour ?? (body.norm_h_per_unit != null && rate ? Math.round(body.norm_h_per_unit * rate * 10000) / 10000 : null);
  const row = (await sql`
    INSERT INTO price_items (file_id, sheet_name, row_idx, item_text, item_norm, unit, norm_h_per_unit, unit_labour,
                             unit_material, hourly_rate, currency, attrs, extracted_by)
    VALUES (${fileId}, ${USER_ROWS_SHEET},
            COALESCE((SELECT max(row_idx) + 1 FROM price_items WHERE file_id = ${fileId} AND sheet_name = ${USER_ROWS_SHEET}), 1),
            ${body.item_text}, ${itemNorm}, ${unit}, ${body.norm_h_per_unit ?? null}, ${labour}, ${body.unit_material ?? null},
            ${rate}, ${summary.currency || 'EUR'}, ${json({ user_added: true, added_by: user.id })}, 'code')
    RETURNING id, file_id, sheet_name, row_idx, item_text, unit, norm_h_per_unit, unit_labour, unit_material, currency, attrs`)[0];
  return { kind, item: row };
}

/** Removes one saved price item / norm. Re-analysis re-extracts rows from the file itself. */
export async function deleteItem(user: SessionUser, fileId: string, itemId: string) {
  const file = await visibleFile(fileId);
  assertCanEditFile(user, file);
  const p = await sql`DELETE FROM price_items WHERE id = ${itemId} AND file_id = ${fileId} RETURNING id`;
  if (p.length) return { ok: true };
  const n = await sql`DELETE FROM norms WHERE id = ${itemId} AND file_id = ${fileId} RETURNING id`;
  if (!n.length) throw notFound();
  return { ok: true };
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
    return { file: publicFile(row), job_id: jobId };
  });
}

export const FILE_PACKAGES = ['containment', 'lighting', 'gs_sp', 'cable', 'electrical'] as const;

/** Blank → null; otherwise trimmed. */
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v);

/**
 * PATCH /api/files/{id}: the file type plus the reference's market / client / package (unit-rate BOQs). The worker
 * keeps a person's market and client when it re-analyses the file.
 */
export const filePatchSchema = z
  .object({
    tag: tagSchema,
    /** Country code of the project ("DE", "NL", "LV"), 2–3 letters; null clears it. */
    market: z.preprocess(
      (v) => { const t = blankToNull(v); return typeof t === 'string' ? t.toUpperCase() : t; },
      z.string().regex(/^[A-Z]{2,3}$/, 'market must be a 2–3 letter code').nullable(),
    ),
    /** Main contractor the estimate is priced for ("Winthrop"); null clears it. */
    client: z.preprocess(blankToNull, z.string().max(120).nullable()),
    package: z.enum(FILE_PACKAGES),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'empty_patch' });

export async function updateFile(user: SessionUser, fileId: string, body: z.infer<typeof filePatchSchema>) {
  const file = await visibleFile(fileId);
  assertCanEditFile(user, file);
  const has = (k: keyof typeof body) => Object.prototype.hasOwnProperty.call(body, k);
  const row = (await sql`
    UPDATE files SET
      tag     = CASE WHEN ${has('tag')} THEN ${body.tag ?? null}::text ELSE tag END,
      market  = CASE WHEN ${has('market')} THEN ${body.market ?? null}::text ELSE market END,
      client  = CASE WHEN ${has('client')} THEN ${body.client ?? null}::text ELSE client END,
      package = CASE WHEN ${has('package')} THEN ${body.package ?? null}::text ELSE package END,
      updated_at = now()
    WHERE id = ${fileId} RETURNING *`)[0];
  return { file: publicFile(row) };
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
