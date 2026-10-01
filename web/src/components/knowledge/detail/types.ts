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
  counts: { price_items: number; price_items_edited: number; norms: number; logic: number; notes: number; sheets: number; sections: number };
  usedIn: UsedIn;
  analysis?: { cost_usd: number; calls: number; tier: string | null };
}
