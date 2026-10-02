'use client';

/** Shared knowledge-base helpers: file type labels, statuses, the polling file list, uploads. */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError } from '@/lib/client';
import { fmtInt, type Tone } from '@/components/ui';

export type FileTag = 'reference_estimate' | 'hourly_norms' | 'price_list' | 'other';
export const TAGS: [FileTag, string][] = [
  ['reference_estimate', 'Priced estimate (reference)'],
  ['hourly_norms', 'Hourly norms'],
  ['price_list', 'Price list'],
  ['other', 'Other'],
];
export const TAG_LABEL: Record<string, string> = Object.fromEntries(TAGS);
export const tagLabel = (t: string) => TAG_LABEL[t] ?? t;

export const BUSY_STATUSES = ['queued', 'reading', 'analysing'];
export const isBusy = (s: string) => BUSY_STATUSES.includes(s);
export const STATUS_LABEL: Record<string, string> = { queued: 'Queued', reading: 'Reading', analysing: 'Analysing', analysed: 'Analysed', failed: 'Failed' };
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;
/** Dot colour of the setup list's status (design: ST in setup.dc.html). */
export const STATUS_FG: Record<string, string> = { queued: 'var(--ink3)', reading: 'var(--acc)', analysing: 'var(--acc)', analysed: 'var(--ok)', failed: 'var(--err)' };
export const STATUS_TONE: Record<string, Tone> = { queued: 'mute', reading: 'acc', analysing: 'acc', analysed: 'ok', failed: 'err' };

export const LANG_NAME: Record<string, string> = { LV: 'Latvian', EN: 'English', DA: 'Danish', LT: 'Lithuanian', ET: 'Estonian', DE: 'German', SV: 'Swedish', NO: 'Norwegian', RU: 'Russian' };

export interface SheetSummary { name: string; kind: string; rows: number; items: number; sections: number; hourly_rates: number[] }
export interface FileSummary {
  sheets?: SheetSummary[];
  currency?: string;
  language?: string;
  sections?: number;
  item_count?: number;
  norm_count?: number;
  description?: string;
  hourly_rates?: number[];
}
export interface FileCounts { price_items: number; price_norms: number; norms: number; notes: number; sections: number; used_in: number; install_rates?: number; supply_rates?: number }
export type PricingModel = 'hourly_norm' | 'unit_rate';
export interface FileRow {
  id: string;
  original_name: string;
  ext: string;
  size_bytes: number;
  tag: string;
  status: string;
  progress: number;
  fail_reason: string | null;
  language: string | null;
  summary: FileSummary | null;
  created_at: string;
  updated_at: string;
  analysed_at: string | null;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  counts?: FileCounts;
  /** 'unit_rate': EU subcontract BOQ priced per unit (Total = Quantity × Rate, no hours). */
  pricing_model?: PricingModel;
  market?: string | null;
  client?: string | null;
  end_client?: string | null;
  package?: string | null;
  project?: string | null;
  doc_date?: string | null;
  analysis?: Record<string, unknown> | null;
}

export const PACKAGES: [string, string][] = [
  ['containment', 'Containment'],
  ['lighting', 'Lighting'],
  ['gs_sp', 'General services / small power'],
  ['cable', 'Cable'],
  ['electrical', 'Electrical services (several packages)'],
];
export const packageLabel = (p: string | null | undefined) => (p ? Object.fromEntries(PACKAGES)[p] ?? p : '—');
export const isUnitRate = (f: Pick<FileRow, 'pricing_model'>) => f.pricing_model === 'unit_rate';

/** Small "Unit rate · DE" tag that sets unit-rate BOQs apart from hourly-norm tāmes. */
export function UnitRateTag({ market, style }: { market?: string | null; style?: CSSProperties }) {
  return (
    <span title="Unit-rate BOQ: Total = Quantity × Rate, no hours"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 7px', borderRadius: 5, background: 'var(--webSoft)', color: 'var(--web)', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', flex: 'none', ...style }}>
      Unit rate{market ? <span style={{ fontFamily: 'var(--mono)', fontWeight: 500 }}>· {market}</span> : null}
    </span>
  );
}

/** GET /api/files, re-polled every 2 s while any file is queued, being read or analysed. */
export function useFiles() {
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    try {
      const r = await api<{ files: FileRow[] }>('/api/files');
      if (alive.current) { setFiles(r.files); setError(null); }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    reload();
    return () => { alive.current = false; };
  }, [reload]);
  const busy = (files ?? []).some((f) => isBusy(f.status));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [busy, reload]);
  return { files, error, reload };
}

/** Guess a file's type from its name (the user can change it). */
export function guessTag(name: string, fallback: FileTag = 'reference_estimate'): FileTag {
  if (/norm/i.test(name)) return 'hourly_norms';
  if (/pri[cs]|cen[ao]|price|prislist/i.test(name)) return 'price_list';
  if (/\.xlsx?$/i.test(name)) return fallback;
  return fallback === 'reference_estimate' ? 'other' : fallback;
}

export const ACCEPT = '.xlsx,.xls,.docx,.pdf';
export const MAX_BYTES = 50 * 1024 * 1024;

/** Plain-language reason for an upload the server refused. */
export function uploadError(e: unknown, file: File): string {
  if (!/\.(xlsx|xls|docx|pdf)$/i.test(file.name)) return 'This file type can’t be read. Upload an .xlsx, .xls, .docx or .pdf file.';
  if (file.size > MAX_BYTES) return 'This file is larger than 50 MB. Split it or save a smaller copy and upload it again.';
  if (e instanceof ApiError) {
    const code = String(e.body?.error ?? '');
    if (code.includes('too_large') || e.status === 413) return 'This file is larger than 50 MB. Split it or save a smaller copy and upload it again.';
    if (code.includes('ext') || code.includes('type')) return 'This file type can’t be read. Upload an .xlsx, .xls, .docx or .pdf file.';
    if (code === 'empty_file') return 'This file is empty.';
    return `The upload failed (${e.message}). Try again.`;
  }
  return 'The upload failed because the connection dropped. Try again.';
}

/** Upload; a byte-identical file already in the knowledge base comes back as that file with duplicate = true. */
export async function uploadFile(file: File, tag: string): Promise<FileRow & { duplicate?: boolean }> {
  const fd = new FormData();
  fd.set('file', file);
  fd.set('tag', tag);
  const r = await api<{ file: FileRow; duplicate?: boolean }>('/api/files', { method: 'POST', body: fd });
  return { ...r.file, duplicate: !!r.duplicate };
}

/** "640 prices · 598 norms", "46 norms", "12 notes"; "In progress" while analysing. */
export function extractedLabel(f: FileRow): string {
  if (isBusy(f.status)) return 'In progress';
  if (f.status === 'failed') return f.fail_reason || 'Failed';
  const c = f.counts;
  if (!c) return '—';
  const parts: string[] = [];
  if (isUnitRate(f)) {
    const ins = c.install_rates ?? 0, sup = c.supply_rates ?? 0;
    if (ins) parts.push(`${fmtInt(ins)} install`);
    if (sup) parts.push(`${fmtInt(sup)} supply`);
    if (parts.length) return `${parts.join(' · ')} rate${ins + sup === 1 ? '' : 's'}`;
    if (c.price_items) return `${fmtInt(c.price_items)} rate${c.price_items === 1 ? '' : 's'}`;
    return c.notes ? `${fmtInt(c.notes)} note${c.notes === 1 ? '' : 's'}` : 'Nothing extracted';
  }
  const prices = c.price_items, norms = c.norms + c.price_norms;
  if (prices) parts.push(`${fmtInt(prices)} price${prices === 1 ? '' : 's'}`);
  if (norms) parts.push(`${fmtInt(norms)} norm${norms === 1 ? '' : 's'}`);
  if (!parts.length && c.notes) parts.push(`${fmtInt(c.notes)} note${c.notes === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'Nothing extracted';
}

export function usedLabel(f: FileRow): string {
  const n = f.counts?.used_in ?? 0;
  return n ? `${fmtInt(n)} estimate${n === 1 ? '' : 's'}` : '—';
}

/** "Today", "12 Sep" (this year) or "12 Sep 2025". */
export function shortDate(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** Knowledge-base subtitle for the document viewer. */
export function viewerSubtitle(tag: string) {
  return `Knowledge base · ${tagLabel(tag)}`;
}
