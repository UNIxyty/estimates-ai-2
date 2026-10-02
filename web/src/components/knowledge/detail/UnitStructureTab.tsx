'use client';

/**
 * Structure of a unit-rate BOQ: per pricing sheet its layout (A / B / C), which columns hold what, whether input
 * cells are marked, the sections with their pricing basis and the notes that change what a rate means; the Summary
 * lines (with packages marked "Not participating"); and the sheets that are not priced line by line.
 */
import { fmtInt } from '@/components/ui';
import { packageLabel } from '../shared';
import type { UrAnalysis, UrSheet } from './types';
import { BasisChip, Chip, eur, LINE_PACKAGE, muted, NoteRow, panel, sectionTitle } from './unitRate';

const LAYOUT: Record<string, [string, string]> = {
  A: ['single install rate', 'Each row has one rate per unit: Total = Quantity × Rate.'],
  B: ['install rate + material supply rate', 'Each row has an install rate and a separate material supply rate per unit.'],
  C: ['phase split', 'Quantities are split by phase; the rate per unit applies to the summed quantity.'],
};

/** Column roles the worker detects (worker/app/unitrate/boq.py `cols`). */
const COL_LABEL: [string, string][] = [
  ['tag', 'Tag'], ['desc', 'Item'], ['qty', 'Quantity'], ['uom', 'UoM'], ['rate', 'Rate'], ['unit_price', 'Unit price'],
  ['total', 'Total'], ['supply', 'Supply rate'], ['supply_total', 'Supply total'],
];

const OTHER_KIND: Record<string, string> = {
  summary: 'Summary — totals per package, links to the pricing sheets',
  attendance: 'Site attendance — who provides what on site',
  prelims: 'Preliminaries — weekly staff rates and one-off items',
  takeoff: 'Quantity takeoff — quantities only, no rates',
  calc: 'Calculation — working sheet, not read as rates',
  other: 'Not used',
};

export function UnitStructureTab({ a }: { a: UrAnalysis }) {
  const sheets = a.sheets ?? [];
  const pricing = sheets.filter((s) => s.kind === 'pricing');
  const other = sheets.filter((s) => s.kind !== 'pricing');
  const lines = a.summary_lines ?? [];
  const notPart = a.not_participating ?? lines.filter((l) => l.not_participating).map((l) => l.label);
  if (!sheets.length) {
    return <div style={{ fontSize: 14, color: 'var(--ink2)' }}>No sheets were found in this file.</div>;
  }
  return (
    <>
      <div style={{ fontSize: 14, color: 'var(--ink2)', lineHeight: 1.55 }}>
        Unit-rate BOQ: every line is Quantity × Rate in € per m, no, item, week or month. The rate already covers labour,
        plant and margin; there are no hours. The agent found {fmtInt(pricing.length)} pricing sheet{pricing.length === 1 ? '' : 's'}
        {other.length ? ` and ${fmtInt(other.length)} other sheet${other.length === 1 ? '' : 's'}` : ''}.
      </div>

      {pricing.map((s) => <PricingSheet key={s.name} s={s} notParticipating={lines.some((l) => l.not_participating && l.link?.sheet?.trim() === s.name.trim())} />)}

      {(lines.length > 0 || notPart.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={sectionTitle}>Summary</div>
          {notPart.length > 0 && (
            <div style={{ padding: '10px 14px', borderRadius: 12, background: 'var(--warnSoft)', fontSize: 13.5, lineHeight: 1.5 }}>
              <b style={{ fontWeight: 600 }}>Not participating:</b> {notPart.join('; ')}. These packages are left unpriced on purpose; the agent doesn&apos;t learn rates from them.
            </div>
          )}
          {lines.length > 0 && (
            <div style={panel}>
              {lines.map((l, i) => (
                <div key={`${l.row ?? i}-${l.label}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '9px 16px', borderBottom: i === lines.length - 1 ? 0 : '1px solid var(--line2)', fontSize: 13.5, opacity: l.not_participating ? 0.75 : 1 }}>
                  <span style={{ flex: 1, minWidth: 180, textDecoration: l.not_participating ? 'line-through' : undefined }}>{l.label}</span>
                  {l.not_participating && <Chip tone="warn">Not participating</Chip>}
                  {l.optional && <Chip>Optional</Chip>}
                  {l.prelims && <Chip>Preliminaries</Chip>}
                  {l.supply && <Chip tone="web">Material supply</Chip>}
                  {l.package && !l.prelims && <span style={{ fontSize: 12.5, color: 'var(--ink3)' }}>{LINE_PACKAGE[l.package] ?? l.package}</span>}
                  {l.link?.sheet && <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink3)', whiteSpace: 'nowrap' }}>→ {l.link.sheet.trim()}{l.link.cell ? ` ${l.link.cell}` : ''}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {other.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={sectionTitle}>Other sheets</div>
          <div style={panel}>
            {other.map((s, i) => (
              <div key={s.name} style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', padding: '9px 16px', borderBottom: i === other.length - 1 ? 0 : '1px solid var(--line2)', fontSize: 13.5 }}>
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, minWidth: 160 }}>{s.name.trim()}</span>
                <span style={{ color: 'var(--ink2)' }}>{OTHER_KIND[s.kind] ?? s.kind}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {a.is_takeoff && <div style={muted}>This file holds a quantity takeoff next to the priced sheet; only the priced sheet teaches rates.</div>}
    </>
  );
}

function PricingSheet({ s, notParticipating }: { s: UrSheet; notParticipating: boolean }) {
  const lay = s.layout ? LAYOUT[s.layout] : null;
  const cols = s.columns ?? {};
  const colList = COL_LABEL.filter(([k]) => cols[k]).map(([k, l]) => [l, cols[k]] as const)
    .concat(Object.keys(cols).filter((k) => !COL_LABEL.some(([x]) => x === k)).map((k) => [k, cols[k]] as const));
  const secs = s.sections ?? [];
  const notes = s.notes ?? [];
  const splits = [
    s.phases?.length ? `Phases: ${s.phases.join(', ')}` : null,
    s.buildings?.length ? `Buildings: ${s.buildings.join(', ')}` : null,
    s.areas?.length ? `Areas: ${s.areas.map((x) => x[0] + x.slice(1).toLowerCase()).join(', ')}` : null,
  ].filter(Boolean) as string[];
  const t = s.totals ?? {};
  return (
    <div style={panel}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--line2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{s.name.trim()}</span>
          {s.layout && <Chip tone="acc" title={lay?.[1]}>Layout {s.layout}</Chip>}
          {s.package && <span style={{ fontSize: 12.5, color: 'var(--ink2)' }}>{packageLabel(s.package)}</span>}
          {notParticipating && <Chip tone="warn" title="The Summary marks this package “Not participating”: it is left unpriced on purpose">Not participating</Chip>}
          <span style={{ fontSize: 12.5, color: 'var(--ink3)', marginLeft: 'auto' }}>
            {fmtInt(s.items ?? 0)} item{s.items === 1 ? '' : 's'} · {fmtInt(s.priced ?? 0)} priced
          </span>
        </div>
        {lay && <div style={muted}><b style={{ fontWeight: 600, color: 'var(--ink)' }}>Layout {s.layout} — {lay[0]}.</b> {lay[1]}</div>}
        {splits.length > 0 && <div style={muted}>{splits.join(' · ')}</div>}
        {colList.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {colList.map(([label, col]) => (
              <span key={label} style={{ height: 24, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 9px', borderRadius: 12, background: 'var(--sunk)', fontSize: 12.5 }}>
                <span style={{ color: 'var(--ink3)' }}>{label}</span><b style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{col}</b>
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--ink2)' }}>
          <span>
            {s.input_fill
              ? <><span aria-hidden style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#cfe5f7', border: '1px solid #9cc5e8', marginRight: 6, verticalAlign: -1 }} />Input cells marked (light-blue fill)</>
              : 'Input cells not marked'}
          </span>
          {s.has_supply && <span>Has a material supply column</span>}
          {t.total != null && <span>Total {eur(t.total, 0)}</span>}
          {t.supply_total != null && <span>Supply total {eur(t.supply_total, 0)}</span>}
        </div>
      </div>
      {notes.map((n) => <NoteRow key={n}>{n}</NoteRow>)}
      {secs.map((x, i) => (
        <div key={`${x.row}-${x.title}`} style={{ borderBottom: i === secs.length - 1 ? 0 : '1px solid var(--line2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 16px', fontSize: 13.5 }}>
            <span style={{ flex: 1, minWidth: 180 }}>{x.title}</span>
            <BasisChip basis={x.basis} sectionTitle={x.title} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink3)', whiteSpace: 'nowrap' }}>row {x.row}</span>
          </div>
          {(x.notes ?? []).map((n) => <NoteRow key={n} style={{ borderBottom: 0, borderTop: '1px solid var(--line2)' }}>{n}</NoteRow>)}
        </div>
      ))}
    </div>
  );
}
