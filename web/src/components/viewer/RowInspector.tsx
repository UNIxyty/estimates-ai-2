'use client';

/**
 * Row inspector (design/DocViewer.dc.html `ins`): where a generated row's price came from, how sure the agent
 * is, and an editor for Quantity / Norm / Unit price that writes a new workbook version (the row becomes EDITED).
 * Data: GET/PATCH /api/documents/{id}/rows/{sheet}/{row} (estimate_rows provenance).
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { api, ApiError } from '@/lib/client';
import { MONO, fmtWhen } from '../ui';
import type { DocRef, Jump } from './types';
import { rowUrl, type Provenance } from './viewerApi';
import s from './Viewer.module.css';

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const parse = (t: string): number | null => {
  const c = t.replace(/\s/g, '').replace(',', '.');
  if (c === '') return null;
  const n = Number(c);
  return Number.isFinite(n) ? n : NaN;
};
const fmt = (n: number | null | undefined, max = 2, min = 0) =>
  n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
const plain = (n: number | null) => (n == null ? '' : String(Math.round(n * 10000) / 10000));
const host = (u?: string) => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : ''; } catch { return u ?? ''; } };

const CONF: Record<string, [string, string, string]> = {
  high: ['High', 'var(--ok)', 'var(--okSoft)'],
  medium: ['Medium', 'var(--warn)', 'var(--warnSoft)'],
  low: ['Low', 'var(--err)', 'var(--errSoft)'],
};

export function RowInspector({ documentId, sheet, row, isSheet, currency, onClose, onMissing, onSaved, onOpenDoc }: {
  documentId: string;
  sheet: string;
  row: number;
  isSheet: boolean;
  currency?: string | null;
  onClose: () => void;
  onMissing: () => void;
  onSaved: (row: number, document?: Record<string, unknown>) => void;
  onOpenDoc: (d: DocRef, j?: Jump) => void;
}) {
  const url = rowUrl(documentId, sheet, row);
  const [p, setP] = useState<Provenance | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ q: string; norm: string; um: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    setP(null); setDraft(null); setLoadErr(null); setSaveErr(null);
    api<{ row: Provenance }>(url)
      .then((r) => { if (!off) { setP(r.row); setDraft({ q: plain(toNum(r.row.qty)), norm: plain(toNum(r.row.norm_h_per_unit)), um: plain(toNum(r.row.unit_material)) }); } })
      .catch((e) => { if (off) return; if (e instanceof ApiError && e.status === 404) onMissing(); else setLoadErr('Could not load the details of this row.'); });
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const pos: CSSProperties = isSheet
    ? { left: 0, right: 0, bottom: 0, maxHeight: '72%', borderRadius: '12px 12px 0 0' }
    : { right: 16, top: 52, width: 340, maxHeight: 'calc(100% - 110px)', borderRadius: 12 };
  const shell: CSSProperties = { position: 'absolute', zIndex: 10, overflow: 'auto', background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: '0 12px 40px rgba(16,24,40,0.18)', display: 'flex', flexDirection: 'column', ...pos };
  const closeBtn = (
    <button type="button" onClick={onClose} aria-label="Close inspector" className={s.ghost}
      style={{ marginLeft: 'auto', width: 26, height: 26, border: 0, borderRadius: 6, background: 'transparent', color: 'var(--ink3)', fontSize: 16, cursor: 'pointer' }}>×</button>
  );

  if (!p || !draft) {
    return (
      <div style={shell} role="dialog" aria-label="Row details">
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center' }}><span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--ink3)' }}>{sheet} · row {row}</span>{closeBtn}</div>
          {loadErr ? <div style={{ fontSize: 12.5, color: 'var(--err)' }}>{loadErr}</div> : (
            <>
              <div className={s.skel} style={{ height: 12, borderRadius: 4, width: '70%' }} />
              <div className={s.skel} style={{ height: 10, borderRadius: 4, width: '45%' }} />
            </>
          )}
        </div>
      </div>
    );
  }

  const q0 = toNum(p.qty), n0 = toNum(p.norm_h_per_unit), m0 = toNum(p.unit_material), rate = toNum(p.hourly_rate), ul0 = toNum(p.unit_labour);
  const q = parse(draft.q), n = parse(draft.norm), m = parse(draft.um);
  const invalid = [q, n, m].some((x) => x !== null && Number.isNaN(x));
  const normChanged = n !== n0;
  const labourUnit = normChanged && rate != null && n != null && !Number.isNaN(n) ? n * rate : ul0;
  const rowTotal = !invalid && q != null ? q * ((labourUnit ?? 0) + (m ?? 0)) : null;
  const changes: Record<string, number | null> = {};
  if (q !== q0) changes.qty = q;
  if (normChanged) changes.norm_h_per_unit = n;
  if (m !== m0) changes.unit_material = m;
  const dirty = Object.keys(changes).length > 0;

  const reason = (p.reason ?? '').replace(/( \(edited by user\))+/g, '').trim();
  const edited = p.price_source === 'edited' || (p.flags ?? []).includes('EDITED');
  const conf = p.confidence ? CONF[p.confidence] : null;
  const [confLabel, confFg, confBg] = edited
    ? ['Set by you', 'var(--accInk)', 'var(--accSoft)']
    : p.price_source === 'none' ? ['No price found', 'var(--err)', 'var(--errSoft)']
    : conf ? [`${conf[0]} confidence${p.confidence_pct != null ? ` · ${p.confidence_pct}%` : ''}`, conf[1], conf[2]]
    : ['Confidence not rated', 'var(--ink2)', 'var(--sunk)'];

  const ref = (p.matched ?? []).find((x) => x.file_id) ?? null;
  const refSheet = ref?.sheet?.trim();
  const openRef = () => { if (ref?.file_id) onOpenDoc({ source: 'file', id: ref.file_id, name: ref.file_name ?? 'Reference file' }, { sheet: ref.sheet, row: ref.row }); };
  const unit = p.unit || 'unit';

  const save = async () => {
    if (!dirty || invalid || saving) return;
    setSaving(true); setSaveErr(null);
    try {
      const res = await api<{ document?: Record<string, unknown> }>(url, { method: 'PATCH', json: changes });
      onSaved(row, res.document);
    } catch (e) {
      setSaveErr(e instanceof ApiError ? `The change was not saved (${e.message}).` : 'The change was not saved.');
      setSaving(false);
    }
  };

  const label: CSSProperties = { fontSize: 11.5, color: 'var(--ink3)' };
  const inp: CSSProperties = { height: 32, padding: '0 8px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)', fontFamily: MONO, fontSize: 12.5, outlineColor: 'var(--acc)', minWidth: 0 };
  const linkBtn: CSSProperties = { border: 0, padding: 0, background: 'transparent', color: 'var(--accInk)', font: 'inherit', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 };

  let priceSource: React.ReactNode;
  if (p.web && (p.price_source === 'web' || (p.flags ?? []).includes('WEB'))) {
    priceSource = (
      <span>
        <span style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 600, color: 'var(--web)', background: 'var(--webSoft)', padding: '1px 4px', borderRadius: 3 }}>WEB</span>{' '}
        {p.web.url ? <a href={p.web.url} target="_blank" rel="noreferrer noopener">{host(p.web.url)}</a> : (p.web.product ?? 'Supplier website')}
        {p.web.fetched_at ? `, checked ${fmtWhen(p.web.fetched_at)}` : ''}
        {p.web.unit_price != null ? ` · ${p.web.currency ?? ''} ${fmt(toNum(p.web.unit_price), 2, 2)}`.replace('  ', ' ') : ''}
      </span>
    );
  } else if (p.price_source === 'none') priceSource = <span>No price found in references or on supplier sites</span>;
  else if (p.price_source === 'pending_permission') priceSource = <span>Waiting for your permission to search supplier websites</span>;
  else if (p.price_source === 'model') priceSource = <span>Estimated by the agent (no matching reference row)</span>;
  else if (edited) priceSource = <span>Changed by you{p.edited_at ? ` · ${fmtWhen(p.edited_at)}` : ''}</span>;
  else if (ref) priceSource = <span>{ref.file_name}{refSheet ? ` · ${refSheet}` : ''}{ref.row ? ` row ${ref.row}` : ''}</span>;
  else if (p.price_source === 'norm') priceSource = <span>Labour from the hourly norms × rate</span>;
  else priceSource = <span>—</span>;

  return (
    <div style={shell} role="dialog" aria-label={`Row ${row} details`}>
      <div style={{ padding: '14px 16px 12px', display: 'flex', flexDirection: 'column', gap: 4, borderBottom: '1px solid var(--line2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--ink3)' }}>{sheet} · row {row}</span>{closeBtn}</div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{p.item_text}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 5, fontSize: 11.5, fontWeight: 500, color: confFg, background: confBg }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />{confLabel}
          </span>
        </div>
        {reason && <div style={{ fontSize: 12.5, color: 'var(--ink2)', marginTop: 2 }}>{reason}</div>}
      </div>
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10, borderBottom: '1px solid var(--line2)', fontSize: 12.5 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={label}>Matched reference row</span>
          {ref ? (
            <button type="button" onClick={openRef} className={s.refBtn}
              style={{ textAlign: 'left', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 11.5, color: 'var(--accInk)' }}>{ref.file_name}{refSheet ? ` · ${refSheet}` : ''}{ref.row ? ` row ${ref.row}` : ''} ›</span>
              <span>{ref.item_text}{ref.norm_h != null ? ` · ${fmt(toNum(ref.norm_h))} h` : ''}{ref.unit_material != null ? ` · ${fmt(toNum(ref.unit_material), 2, 2)}` : ''}</span>
            </button>
          ) : <span style={{ color: 'var(--ink2)' }}>No reference row matched</span>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={label}>Norm used</span>
          {p.norm_ref?.file_id ? (
            <span>{fmt(toNum(p.norm_ref.hours) ?? n0)} h per {unit} · <button type="button" style={linkBtn}
              onClick={() => onOpenDoc({ source: 'file', id: p.norm_ref!.file_id!, name: p.norm_ref!.file_name ?? 'Norms' })}>{p.norm_ref.file_name ?? 'norms'}</button></span>
          ) : n0 != null ? (
            <span>{fmt(n0)} h per {unit}{ref ? ' · from the matched reference row' : ''}</span>
          ) : <span style={{ color: 'var(--ink2)' }}>No norm</span>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={label}>Price source</span>
          {priceSource}
        </div>
      </div>
      <div style={{ padding: '12px 16px 16px', display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...label }}>Quantity
          <input value={draft.q} inputMode="decimal" onChange={(e) => setDraft({ ...draft, q: e.target.value })} style={inp} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...label }}>Norm, h
          <input value={draft.norm} inputMode="decimal" onChange={(e) => setDraft({ ...draft, norm: e.target.value })} style={inp} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...label }}>Unit price
          <input value={draft.um} inputMode="decimal" onChange={(e) => setDraft({ ...draft, um: e.target.value })} style={inp} />
        </label>
        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--ink2)' }}>
          <span>Row total</span>
          <b style={{ fontFamily: MONO, fontWeight: 600, color: 'var(--ink)' }}>{invalid ? '—' : `${currency ? `${currency} ` : ''}${fmt(rowTotal, 2, 2)}`}</b>
        </div>
        {invalid && <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--err)' }}>Enter numbers only, for example 12 or 0,45.</div>}
        {saveErr && <div role="alert" style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--err)' }}>{saveErr}</div>}
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
          <button type="button" onClick={save} disabled={!dirty || invalid || saving}
            style={{ flex: 1, height: 34, border: 0, borderRadius: 8, background: 'var(--acc)', color: '#fff', font: 'inherit', fontWeight: 600, cursor: dirty && !invalid ? 'pointer' : 'default', opacity: dirty && !invalid ? 1 : 0.55 }}>
            {saving ? 'Saving…' : 'Save change'}
          </button>
          <button type="button" onClick={onClose} style={{ height: 34, padding: '0 14px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
