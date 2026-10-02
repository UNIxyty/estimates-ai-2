'use client';

/**
 * "Rate card" (unit-rate BOQs, in place of "Calculation logic"): the install and supply rates the file teaches,
 * grouped by item and expandable to their source rows; preliminaries, contractor items, materials delivery and
 * accessory ratios.
 */
import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { fmtInt } from '@/components/ui';
import type { UrAnalysis, UrSourceRow } from './types';
import { Chip, eur, FlagChip, monoNum, muted, num, panel, sectionTitle, th } from './unitRate';

interface CardGroup { label: string; range: string; n: number; rows: UrSourceRow[] }

export function RateCardTab({ a }: { a: UrAnalysis }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const match = (g: CardGroup) => !needle || g.label.toLowerCase().includes(needle) || g.rows.some((r) => r.description.toLowerCase().includes(needle));
  const install = useMemo(() => (a.rate_card?.install ?? []).map((g) => ({ label: g.label, range: g.install, n: g.n, rows: g.rows })), [a]);
  const supply = useMemo(() => (a.rate_card?.supply ?? []).map((g) => ({ label: g.label, range: g.supply, n: g.n, rows: g.rows })), [a]);
  const pre = a.prelims ?? {};
  const weekly = pre.weekly ?? [], items = pre.items ?? [], weeks = pre.programme_weeks ?? [];
  const contractor = a.contractor_items ?? [], lumps = a.lump_sums ?? [];
  const delivery = a.delivery ?? [], ratios = a.ratios ?? [];
  // A "Sheet" column only when the rows come from more than one sheet (multi-package BOQs).
  const preSheets = new Set([...weekly, ...items].map((x) => x.sheet)).size > 1;
  const conSheets = new Set([...contractor, ...lumps].map((x) => x.sheet)).size > 1;

  return (
    <>
      <div style={{ fontSize: 14, color: 'var(--ink2)', lineHeight: 1.55 }}>
        The rates this file teaches, in € per unit, grouped by item. A range means the item was priced differently on different rows; open a line to see where each rate came from.
      </div>

      {(install.length > 6 || supply.length > 6) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)' }}>
          <span style={{ color: 'var(--ink3)', fontSize: 13 }}>Search</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Item" aria-label="Search the rate card" style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--ink)', font: 'inherit', fontSize: 14 }} />
        </div>
      )}

      <CardTable title="Install rate card" empty="No install rates in this file." groups={install.filter(match)} total={install.length} searching={!!needle} />
      {(supply.length > 0 || a.sheets?.some((s) => s.has_supply)) && (
        <CardTable title="Supply rate card" empty="No material supply rates in this file." groups={supply.filter(match)} total={supply.length} searching={!!needle} />
      )}

      {(weekly.length > 0 || items.length > 0) && (
        <Block title="Preliminaries" hint={weeks.length ? `Programme ${weeks.length > 1 ? `${num(weeks[0])}–${num(weeks[weeks.length - 1])}` : num(weeks[0])} weeks` : undefined}>
          {weekly.length > 0 && (
            <SimpleTable head={['Staff', ...(preSheets ? ['Sheet'] : []), '€ / week', 'Weeks']} align={['left', ...(preSheets ? ['left' as const] : []), 'right', 'right']}
              widths={[...(preSheets ? [190] : []), 100, 70]}
              rows={weekly.map((w) => [w.description, ...(preSheets ? [w.sheet?.trim() ?? '—'] : []), eur(w.rate), w.weeks != null ? num(w.weeks) : '—'])} />
          )}
          {items.length > 0 && (
            <SimpleTable head={['Item', ...(preSheets ? ['Sheet'] : []), 'Rate', 'Qty']} align={['left', ...(preSheets ? ['left' as const] : []), 'right', 'right']}
              widths={[...(preSheets ? [190] : []), 130, 70]}
              rows={items.map((x) => [x.description, ...(preSheets ? [x.sheet?.trim() ?? '—'] : []), `${eur(x.rate)}${x.uom ? ` / ${x.uom}` : ''}`, x.qty != null ? `${num(x.qty)}${x.uom ? ` ${x.uom}` : ''}` : '—'])} />
          )}
        </Block>
      )}

      {(contractor.length > 0 || lumps.length > 0) && (
        <Block title="Contractor items">
          {contractor.length > 0 && (
            <SimpleTable head={['Item', ...(conSheets ? ['Sheet'] : []), 'Phase', 'Rate', 'Months']} align={['left', ...(conSheets ? ['left' as const] : []), 'left', 'right', 'right']}
              widths={[...(conSheets ? [190] : []), 90, 140, 70]}
              rows={contractor.map((c) => [c.description, ...(conSheets ? [c.sheet?.trim() ?? '—'] : []), c.phase ?? '—', c.rate != null ? `${eur(c.rate)}${c.basis === 'monthly' ? ' / month' : ''}` : '—', c.months != null ? num(c.months) : '—'])} />
          )}
          {lumps.length > 0 && (
            <SimpleTable head={['Lump sum', ...(conSheets ? ['Sheet'] : []), 'Amount']} align={['left', ...(conSheets ? ['left' as const] : []), 'right']}
              widths={[...(conSheets ? [190] : []), 120]}
              rows={lumps.map((l) => [l.description, ...(conSheets ? [l.sheet?.trim() ?? '—'] : []), eur(l.amount, 0)])} />
          )}
        </Block>
      )}

      {delivery.length > 0 && (
        <Block title="Materials delivery">
          <div style={panel}>
            {delivery.map((x, i) => (
              <div key={`${x.sheet}-${x.row ?? i}`} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '11px 16px', borderBottom: i === delivery.length - 1 ? 0 : '1px solid var(--line2)', fontSize: 13.5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ flex: 1, minWidth: 180 }}>{x.description}</span>
                  {x.computed_percent != null && <Chip tone="acc"><b style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{num(x.computed_percent)} %</b> of supply</Chip>}
                  {x.typed_percent != null && <Chip>Typed {num(x.typed_percent)} %</Chip>}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--ink2)' }}>
                  {x.amount != null && x.supply_total ? `${eur(x.amount, 0)} ÷ ${eur(x.supply_total, 0)} material supply` : x.amount != null ? eur(x.amount, 0) : 'No amount'}
                  <span style={{ color: 'var(--ink3)' }}> · {x.sheet.trim()}{x.row ? ` · row ${x.row}` : ''}</span>
                </div>
              </div>
            ))}
          </div>
        </Block>
      )}

      {ratios.length > 0 && (
        <Block title="Accessory ratios" hint="Quantities that follow one anchor item">
          {ratios.map((r) => (
            <div key={`${r.sheet}-${r.section}-${r.anchor_row ?? r.anchor}`} style={panel}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', padding: '10px 16px', borderBottom: '1px solid var(--line2)' }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{r.section}</span>
                <span style={{ fontSize: 12.5, color: 'var(--ink2)' }}>per {r.anchor}{r.anchor_qty != null ? ` (${fmtInt(r.anchor_qty)} in this BOQ)` : ''}</span>
                <span style={{ fontSize: 12, color: 'var(--ink3)', marginLeft: 'auto' }}>{r.sheet.trim()}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))' }}>
                {r.rows.map((x, i) => (
                  <div key={`${x.row ?? i}-${x.description}`} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 16px', fontSize: 13, borderBottom: '1px solid var(--line2)', minWidth: 0 }}>
                    <span style={{ ...monoNum, minWidth: 64, color: 'var(--accInk)', fontWeight: 600 }}>{num(x.ratio, 4)} ×</span>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={x.description}>{x.description}</span>
                    {x.uom && <span style={{ fontSize: 12, color: 'var(--ink3)', flex: 'none' }}>{x.uom}</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Block>
      )}
    </>
  );
}

function Block({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={sectionTitle}>{title}</span>
        {hint && <span style={{ fontSize: 12.5, color: 'var(--ink3)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

const CARD_GRID = 'minmax(0,1fr) 132px 52px';

/** "150–2000" → "150–2,000". */
function fmtRange(t: string): string {
  return String(t).split(/\s*[–-]\s*/).map((x) => (x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x).toLocaleString('en-GB', { maximumFractionDigits: 2 }) : x)).join('–');
}

const FIRST = 15;

function CardTable({ title, groups: allGroups, total, empty, searching }: { title: string; groups: CardGroup[]; total: number; empty: string; searching: boolean }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const groups = all || searching ? allGroups : allGroups.slice(0, FIRST);
  const hidden = allGroups.length - groups.length;
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const flagged = allGroups.filter((g) => g.rows.some((r) => r.flags?.length)).length;
  return (
    <Block title={title} hint={`${fmtInt(total)} item${total === 1 ? '' : 's'}${flagged ? ` · ${flagged} flagged` : ''}`}>
      <div style={panel}>
        <div style={{ display: 'grid', gridTemplateColumns: CARD_GRID, borderBottom: '1px solid var(--line)', padding: '0 8px' }}>
          <div style={th}>Item</div><div style={{ ...th, textAlign: 'right' }}>Rate € / unit</div><div style={{ ...th, textAlign: 'right' }}>Rows</div>
        </div>
        {groups.length === 0 && <div style={{ padding: 20, textAlign: 'center', ...muted, color: 'var(--ink3)' }}>{searching ? 'No items match this search.' : empty}</div>}
        {groups.map((g, i) => {
          const k = `${g.label}#${i}`;
          const on = open.has(k);
          const uoms = [...new Set(g.rows.map((r) => r.uom).filter(Boolean))];
          const flags = [...new Set(g.rows.flatMap((r) => r.flags ?? []))];
          return (
            <Fragment key={k}>
              <button type="button" onClick={() => toggle(k)} aria-expanded={on} className="hv-side"
                style={{ display: 'grid', gridTemplateColumns: CARD_GRID, alignItems: 'center', width: '100%', padding: '0 8px', border: 0, borderBottom: i === groups.length - 1 && !on ? 0 : '1px solid var(--line2)', background: on ? 'var(--side)' : 'transparent', color: 'var(--ink)', font: 'inherit', fontSize: 13.5, textAlign: 'left', cursor: 'pointer' }}>
                <span style={{ padding: '9px 8px', display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                  <span aria-hidden style={{ flex: 'none', width: 10, color: 'var(--ink3)', fontSize: 10, transform: on ? 'rotate(90deg)' : undefined, transition: 'transform .12s' }}>▶</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{g.label}</span>
                    {flags.map((f) => <FlagChip key={f} flag={f} />)}
                  </span>
                </span>
                <span style={{ ...monoNum, padding: '9px 8px', fontSize: 13 }}>
                  €{fmtRange(g.range)}{uoms.length === 1 ? <span style={{ color: 'var(--ink3)' }}> / {uoms[0]}</span> : null}
                </span>
                <span style={{ ...monoNum, padding: '9px 8px', color: 'var(--ink2)' }}>{fmtInt(g.n)}</span>
              </button>
              {on && (
                <div style={{ background: 'var(--side)', borderBottom: i === groups.length - 1 ? 0 : '1px solid var(--line2)', padding: '2px 0 6px' }}>
                  {g.rows.map((r) => (
                    <div key={`${r.sheet}-${r.row}`} style={{ display: 'flex', alignItems: 'baseline', gap: '4px 10px', flexWrap: 'wrap', padding: '5px 16px 5px 34px', fontSize: 12.5 }}>
                      <span style={{ color: 'var(--ink3)', whiteSpace: 'nowrap', fontFamily: 'var(--mono)', fontSize: 12 }}>{r.sheet.trim()} · row {r.row}</span>
                      <span style={{ flex: 1, minWidth: 160, color: 'var(--ink2)', overflowWrap: 'anywhere' }}>{r.description}</span>
                      {(r.flags ?? []).map((f) => <FlagChip key={f} flag={f} />)}
                      <span style={{ ...monoNum, color: r.flags?.length ? 'var(--ink3)' : 'var(--ink)', textDecoration: r.flags?.length ? 'line-through' : undefined }}>
                        {eur(r.rate)}{r.uom ? ` / ${r.uom}` : ''}
                      </span>
                    </div>
                  ))}
                  {g.n > g.rows.length && <div style={{ padding: '4px 16px 4px 34px', fontSize: 12, color: 'var(--ink3)' }}>and {fmtInt(g.n - g.rows.length)} more row{g.n - g.rows.length === 1 ? '' : 's'}</div>}
                </div>
              )}
            </Fragment>
          );
        })}
        {(hidden > 0 || (all && allGroups.length > FIRST && !searching)) && (
          <div style={{ padding: 10, display: 'flex', justifyContent: 'center', borderTop: '1px solid var(--line2)' }}>
            <button type="button" className="hv-sunk" onClick={() => setAll((v) => !v)}
              style={{ height: 32, padding: '0 14px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>
              {hidden > 0 ? `Show all ${fmtInt(allGroups.length)}` : `Show the first ${FIRST}`}
            </button>
          </div>
        )}
      </div>
    </Block>
  );
}

function SimpleTable({ head, rows, align, widths }: { head: string[]; rows: string[][]; align: ('left' | 'right')[]; widths?: number[] }) {
  const grid = `minmax(0,1fr) ${head.slice(1).map((_, j) => `${widths?.[j] ?? 110}px`).join(' ')}`;
  const cellStyle = (j: number): CSSProperties => (align[j] === 'right' ? { ...monoNum, padding: '8px 8px' } : { padding: '8px 8px', minWidth: 0, overflowWrap: 'anywhere' });
  const minWidth = 180 + head.slice(1).reduce((t, _, j) => t + (widths?.[j] ?? 110), 0) + 16;
  return (
    <div style={{ ...panel, overflowX: 'auto' }}>
      <div style={{ minWidth }}>
        <div style={{ display: 'grid', gridTemplateColumns: grid, padding: '0 8px', borderBottom: '1px solid var(--line)' }}>
          {head.map((h, j) => <div key={h} style={{ ...th, textAlign: align[j] }}>{h}</div>)}
        </div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: grid, alignItems: 'baseline', padding: '0 8px', borderBottom: i === rows.length - 1 ? 0 : '1px solid var(--line2)', fontSize: 13.5 }}>
            {r.map((c, j) => <div key={j} style={cellStyle(j)}>{c}</div>)}
          </div>
        ))}
      </div>
    </div>
  );
}
