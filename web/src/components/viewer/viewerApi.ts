/**
 * Endpoints behind the viewer, per document source:
 *   document (agent output)  /api/documents/{id}/sheets|rows|download, rows/{sheet}/{row} (provenance, PATCH edit)
 *   file (knowledge base)    /api/files/{id}/view/sheets|rows|html|raw, /api/files/{id}/download
 *   upload (chat attachment) /api/uploads/{id}/view/sheets|rows|html|raw, /api/uploads/{id}/download
 * Shapes come from worker/app/docview (see xlsx_json.py for the row/cell model).
 */
import type { DocRef } from './types';

export type ViewKind = 'xlsx' | 'pdf' | 'docx' | 'unsupported';

export function extOfName(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Documents are always workbooks; other sources follow the file extension. */
export function viewKind(doc: DocRef): ViewKind {
  if (doc.source === 'document') return 'xlsx';
  const e = extOfName(doc.name);
  if (e === 'xlsx' || e === 'xls' || e === 'xlsm') return 'xlsx';
  if (e === 'pdf') return 'pdf';
  if (e === 'docx') return 'docx';
  return 'unsupported';
}

export function endpoints(doc: DocRef) {
  const id = encodeURIComponent(doc.id);
  if (doc.source === 'document') {
    const b = `/api/documents/${id}`;
    return { meta: b, sheets: `${b}/sheets`, rows: `${b}/rows`, html: '', raw: '', download: `${b}/download` };
  }
  const b = doc.source === 'file' ? `/api/files/${id}` : `/api/uploads/${id}`;
  return {
    meta: doc.source === 'file' ? b : '',
    sheets: `${b}/view/sheets`,
    rows: `${b}/view/rows`,
    html: `${b}/view/html`,
    raw: `${b}/view/raw`,
    download: `${b}/download`,
  };
}

export const rowUrl = (documentId: string, sheet: string, row: number) =>
  `/api/documents/${encodeURIComponent(documentId)}/rows/${encodeURIComponent(sheet)}/${row}`;

/* ---------- worker shapes ---------- */

/** [col (1-based), value, display, flags(, formula)] — flags: b i u f m r c w, then ;bg=..;fg=.. */
export type Cell = [number, unknown, string, string, string?];
export type RowKind = 'item' | 'section' | 'subtotal' | 'total' | 'header' | 'note' | 'blank';
export type Marker = 'WEB' | 'CHECK' | 'NO PRICE' | 'EDITED';

export interface SheetRow {
  r: number;
  h?: number | null;
  kind: RowKind;
  cells: Cell[];
  hidden?: boolean;
  marker?: Marker | null;
  flags?: string[];
  price_source?: string | null;
  confidence?: string | null;
  confidence_pct?: number | null;
  estimate_row_id?: string;
}

export interface MarkerCounts { web: number; check: number; no_price: number; edited: number; flagged: number; attention?: number }

export interface SheetMeta {
  name: string;
  idx: number;
  state: string;
  row_count: number;
  col_count: number;
  col_widths: number[];
  default_row_h: number;
  frozen: { rows: number; cols: number };
  merges: { r1: number; c1: number; r2: number; c2: number }[];
  hidden_rows: number[];
  hidden_cols: number[];
  marker_counts?: MarkerCounts;
  /** Header / section / subtotal / total rows with cells (newer workers). */
  outline?: { r: number; kind: RowKind; cells: Cell[] }[];
}

export interface SheetsResponse { kind: string; id: string; name: string; locale: string; sheets: SheetMeta[] }

export interface RowsResponse { sheet: number; offset: number; limit: number; total: number; rows: SheetRow[]; matches?: number[] }

export type RowFilter = 'all' | 'attention' | 'web' | 'edited';

export interface Provenance {
  id: string;
  sheet_name: string;
  row_idx: number;
  section_title: string | null;
  item_text: string;
  unit: string | null;
  qty: number | string | null;
  norm_h_per_unit: number | string | null;
  hourly_rate: number | string | null;
  unit_labour: number | string | null;
  unit_material: number | string | null;
  total_labour: number | string | null;
  total_material: number | string | null;
  price_source: string;
  confidence: 'high' | 'medium' | 'low' | null;
  confidence_pct: number | null;
  reason: string | null;
  matched: { file_id?: string; file_name?: string; sheet?: string; row?: number; item_text?: string; similarity?: number; norm_h?: number; unit_material?: number; unit_labour?: number }[];
  norm_ref: { norm_id?: string; file_id?: string; file_name?: string; hours?: number; specificity?: string } | null;
  web: { product?: string; unit_price?: number; currency?: string; url?: string; fetched_at?: string } | null;
  flags: string[];
  original: Record<string, unknown> | null;
  edited_at: string | null;
}

export const TAG_LABEL: Record<string, string> = {
  reference_estimate: 'Priced estimate (reference)',
  hourly_norms: 'Hourly norms',
  price_list: 'Price list',
  other: 'Other',
};

/** Human reason for a failed view request (worker error codes → plain language). */
export function failReason(code: string | undefined, reason: string | undefined, status: number): string {
  if (code === 'not_ready') return 'The file is still being converted for viewing. Try again in a moment.';
  if (code === 'unreadable') return `The file could not be read${reason ? ` (${reason})` : ''}. It may be damaged or password-protected.`;
  if (code === 'unsupported') return reason ? `This file type can't be shown in the viewer: ${reason}.` : "This file type can't be shown in the viewer.";
  if (code === 'not_found' || code === 'file_missing' || status === 404) return 'The file could not be found. It may have been deleted.';
  if (code === 'worker_unreachable' || status === 502) return 'The document service is not responding right now.';
  return reason || code || `The viewer request failed (${status}).`;
}
