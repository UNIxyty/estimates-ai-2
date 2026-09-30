import { z } from 'zod';
import { sql } from '@/lib/db';
import { json, notFound, readJson, route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { ownedDocument } from '@/lib/access';
import { proxyWorker } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { id: string; sheet: string; row: string };

function rowNumber(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10_000_000) throw notFound();
  return n;
}

/** Per-row provenance (estimate_rows). */
export const GET = route<P>(async (req, p) => {
  const { user } = await requireUser(req);
  const d = await ownedDocument(user.id, uuidParam(p.id));
  const sheet = safeDecode(p.sheet);
  const r = (await sql`SELECT * FROM estimate_rows WHERE document_id = ${d.id} AND sheet_name = ${sheet} AND row_idx = ${rowNumber(p.row)}`)[0];
  if (!r) throw notFound();
  return json({ row: r });
});

const patchSchema = z
  .object({
    qty: z.number().nullable().optional(),
    unit_labour: z.number().nullable().optional(),
    unit_material: z.number().nullable().optional(),
    norm_h_per_unit: z.number().nullable().optional(),
  })
  .strict();

/** Edit a row: ownership checked here, the worker recalculates and writes a new workbook version. */
export const PATCH = route<P>(async (req, p) => {
  const { user } = await requireUser(req);
  const d = await ownedDocument(user.id, uuidParam(p.id));
  const body = await readJson(req, patchSchema);
  const sheet = safeDecode(p.sheet);
  return proxyWorker(`/internal/documents/${d.id}/rows/${encodeURIComponent(sheet)}/${rowNumber(p.row)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, user_id: user.id }),
  });
});

function safeDecode(v: string): string {
  try {
    return /%[0-9a-f]{2}/i.test(v) ? decodeURIComponent(v) : v;
  } catch {
    return v;
  }
}
