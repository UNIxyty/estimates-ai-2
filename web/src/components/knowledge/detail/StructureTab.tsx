'use client';

import { fmtInt } from '@/components/ui';
import type { Detail, Sheet, SheetCol } from './types';

/** Plain-English meaning of each column role the analyser detects (worker/app/ingest/structure.py MEANINGS). */
const MEANING: Record<string, string> = {
  no: 'Item number, e.g. 2.04',
  code: 'Item or catalogue code',
  item: 'Item description',
  unit: 'Unit (pcs, m, …)',
  qty: 'Quantity',
  norm_h: 'Hours per unit',
  hourly_rate: 'Hourly rate',
  unit_labour: 'Labour per unit = hours per unit × hourly rate',
  unit_material: 'Material unit price',
  unit_mechanisms: 'Machinery per unit',
  unit_total: 'Unit total = labour + material per unit',
  total_norm_h: 'Hours = quantity × hours per unit',
  total_labour: 'Labour = quantity × labour per unit',
  total_material: 'Material = quantity × unit price',
  total_mechanisms: 'Machinery = quantity × machinery per unit',
  total: 'Row total',
  source: 'Where the price came from',
  notes: 'Notes',
  category: 'Category',
  unknown: 'Not used by the agent',
};

const SHEET_KIND: Record<string, string> = { summary: 'summary', norms: 'norms', prices: 'prices', other: 'not used' };

export function StructureTab({ d }: { d: Detail }) {
  const sheets = d.sheets;
  // Sheets with the same column layout share one "Column layout" table.
  const groups: { sheets: Sheet[]; cols: SheetCol[] }[] = [];
  for (const s of sheets) {
    const cols = (s.columns || []).filter((c) => c.header || c.meaning !== 'unknown');
    if (!cols.length) continue;
    const sig = cols.map((c) => `${c.col}:${c.meaning}:${c.header ?? ''}`).join('|');
    const g = groups.find((x) => x.cols.map((c) => `${c.col}:${c.meaning}:${c.header ?? ''}`).join('|') === sig);
    if (g) g.sheets.push(s); else groups.push({ sheets: [s], cols });
  }
  if (!sheets.length) {
    return <div style={{ fontSize: 14, color: 'var(--ink2)' }}>{d.file.ext === 'xlsx' || d.file.ext === 'xls' ? 'No sheets were found in this file.' : 'This document has no sheets. The agent reads its text and tables directly.'}</div>;
  }
  return (
    <>
      <div style={{ fontSize: 14, color: 'var(--ink2)' }}>The agent found {sheets.length} sheet{sheets.length === 1 ? '' : 's'}. New estimates built from this file copy this layout.</div>
      {sheets.map((s) => {
        const secs = d.sections.filter((x) => x.sheet_id === s.id);
        return (
          <div key={s.id} style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: secs.length ? '1px solid var(--line2)' : 0, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{s.name.trim() || s.name}</span>
              <span style={{ fontSize: 12.5, color: 'var(--ink3)' }}>{fmtInt(s.row_count)} rows{SHEET_KIND[s.kind] ? ` · ${SHEET_KIND[s.kind]}` : ''}{s.currency ? ` · ${s.currency}` : ''}</span>
            </div>
            {secs.map((x, i) => (
              <div key={x.id} style={{ display: 'flex', gap: 12, padding: '9px 16px', borderBottom: i === secs.length - 1 ? 0 : '1px solid var(--line2)', fontSize: 13.5 }}>
                <span style={{ flex: 1, minWidth: 0 }}>{x.title}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink3)', whiteSpace: 'nowrap' }}>{x.row_start === x.row_end ? `row ${x.row_start}` : `rows ${x.row_start}–${x.row_end}`}</span>
              </div>
            ))}
          </div>
        );
      })}
      {groups.map((g) => (
        <div key={g.sheets.map((s) => s.id).join()} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            Column layout{groups.length > 1 || sheets.length > 1 ? <span style={{ fontWeight: 400, color: 'var(--ink3)' }}> · {g.sheets.map((s) => s.name.trim()).join(', ')}</span> : null}
          </div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', overflow: 'hidden' }}>
            {g.cols.map((c, i) => (
              <div key={c.col} style={{ display: 'grid', gridTemplateColumns: '36px 150px minmax(0,1fr)', gap: 8, padding: '9px 16px', borderBottom: i === g.cols.length - 1 ? 0 : '1px solid var(--line2)', fontSize: 13.5, alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink3)' }}>{c.col}</span>
                <span style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{c.header || '—'}</span>
                <span style={{ color: c.meaning === 'unknown' ? 'var(--ink3)' : 'var(--ink2)' }}>{MEANING[c.meaning] ?? c.meaning}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
