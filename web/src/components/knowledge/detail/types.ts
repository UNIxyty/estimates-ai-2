import type { FileRow } from '../shared';

export interface SheetCol { col: string; idx: number; header: string | null; meaning: string; source?: string; confidence?: number }
export interface Sheet { id: string; idx: number; name: string; kind: string; row_count: number; col_count: number; header_row: number | null; columns: SheetCol[]; currency: string | null }
export interface Section { id: string; sheet_id: string | null; ord: number; title: string; row_start: number; row_end: number; hourly_rate: string | number | null }
export interface Logic {
  id: string; kind: string; logic_key: string; sheet_name: string | null; section_title: string | null;
  sentence: string; effective_sentence: string; effective_numbers: Record<string, unknown>; edited: boolean; overridden_by_name: string | null;
}
export interface Note { id: string; text: string; source: 'model' | 'user'; edited: boolean; label: string | null; created_by: string | null; created_by_name: string | null }
export interface UsedIn { total: number; others: number; mine: { conversation_id: string; title: string; rows_used: number; last_used: string; language: string | null }[] }
export interface Detail {
  file: FileRow & { stats?: Record<string, unknown>; mime?: string };
  sheets: Sheet[];
  sections: Section[];
  logic: Logic[];
  notes: Note[];
  counts: { price_items: number; price_items_edited: number; norms: number; logic: number; notes: number; sheets: number; sections: number; install_rates?: number; supply_rates?: number };
  usedIn: UsedIn;
  analysis?: { cost_usd: number; calls: number; tier: string | null };
}

/* ---------- unit-rate BOQs (files.analysis, worker/app/unitrate/analysis.py build_analysis) ---------- */

export type RateBasis = 'install_only' | 'supply_only' | 'supply_and_install' | 'lump_sum' | 'weekly' | 'monthly' | 'percent';
export interface CellValue { cell?: string | null; value?: string | number | null }
export interface UrSummaryLine {
  label: string; code?: string | null; row?: number; cell?: string | null; link?: { sheet?: string | null; cell?: string | null } | null;
  package?: string | null; not_participating?: boolean; supply?: boolean; prelims?: boolean; optional?: boolean;
}
export interface UrSection { title: string; row: number; basis: RateBasis | null; notes: string[] }
export interface UrSheet {
  name: string; kind: string; layout?: 'A' | 'B' | 'C' | null; package?: string | null; columns?: Record<string, string>;
  has_supply?: boolean; phases?: string[]; buildings?: string[]; areas?: string[]; input_fill?: boolean;
  items?: number; priced?: number; sections?: UrSection[]; bases?: Record<string, string[]>; notes?: string[];
  totals?: Record<string, number>;
}
export interface UrSourceRow { sheet: string; row: number; description: string; rate: number; uom: string | null; flags?: string[] }
export interface UrCardInstall { label: string; install: string; n: number; rows: UrSourceRow[] }
export interface UrCardSupply { label: string; supply: string; n: number; rows: UrSourceRow[] }
export interface UrAnalysis {
  pricing_model: 'unit_rate';
  project?: string | null; client?: string | null; end_client?: string | null; market?: string | null;
  package?: string | null; package_label?: string | null; doc_date?: string | null; currency?: string | null;
  language?: string | null; is_takeoff?: boolean;
  subcontractor?: { name?: CellValue | null; offer_date?: CellValue | null; validity?: CellValue | null } | null;
  summary_lines?: UrSummaryLine[];
  not_participating?: string[];
  sheets?: UrSheet[];
  rate_card?: { install?: UrCardInstall[]; supply?: UrCardSupply[] };
  prelims?: {
    weekly?: { description: string; rate: number; weeks: number | null; sheet?: string; row?: number }[];
    items?: { description: string; rate: number; qty: number | null; uom: string | null; sheet?: string; row?: number }[];
    programme_weeks?: number[];
  };
  contractor_items?: { description: string; phase: string | null; months: number | null; rate: number | null; basis: string | null; sheet?: string; row?: number }[];
  lump_sums?: { description: string; amount: number | null; sheet?: string; row?: number }[];
  delivery?: { sheet: string; row?: number; description: string; typed_percent: number | null; amount: number | null; supply_total: number | null; computed_percent: number | null }[];
  ratios?: { sheet: string; section: string; anchor: string; anchor_qty: number | null; anchor_row?: number; rows: { row?: number; description: string; ratio: number; uom: string | null; formula?: string | null }[] }[];
  attendance?: { items?: number; by_subcontractor?: number } | null;
  agent_notes?: string[];
}

/** The file's unit-rate analysis, or null for hourly-norm files. */
export function unitRate(d: Detail): UrAnalysis | null {
  if (d.file.pricing_model !== 'unit_rate') return null;
  const a = d.file.analysis;
  return a && typeof a === 'object' ? (a as unknown as UrAnalysis) : ({ pricing_model: 'unit_rate' } as UrAnalysis);
}
