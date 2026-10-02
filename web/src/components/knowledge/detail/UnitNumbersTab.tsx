'use client';

/**
 * "Saved numbers" for a unit-rate BOQ: Item | UoM | Install €/unit | Supply €/unit | Basis | Package | Found in.
 * Install and supply rates are edited inline and staged; "Save changes" writes them as overrides
 * (PATCH /items/{id} with install_rate / supply_rate). Rows are not added by hand here.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api } from '@/lib/client';
import { fmtInt, Spinner } from '@/components/ui';
import styles from '../knowledge.module.css';
import { parseNum } from './NumbersTab';
import type { Detail } from './types';
import { basisLabel, FlagChip, LINE_PACKAGE } from './unitRate';

interface Item {
  id: string;
  sheet_name: string | null;
  row_idx: number | null;
  section_title: string | null;
  item_text: string;
  unit: string | null;
  rate_basis: string | null;
  package: string | null;
  rate_key: string | null;
  flags: string[] | null;
  attrs?: Record<string, unknown> | null;
  edited: boolean;
  effective: Record<string, unknown>;
}
interface ItemsResp { kind: 'price_items' | 'norms'; total: number; offset: number; limit: number; items: Item[] }
interface Draft { ins: string; sup: string }

const PAGE = 200;
const GRID = 'minmax(200px,1fr) 48px 100px 100px 156px 96px 140px';

function rateStr(v: unknown): string {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2).replace(/(\.\d\d\d*?)0+$/, '$1');
}
const bad = (s: string) => { const n = parseNum(s); return n !== null && (Number.isNaN(n) || n < 0); };

export function UnitNumbersTab({ d, canEdit, onChanged }: { d: Detail; canEdit: boolean; onChanged: () => void }) {
  const fileId = d.file.id;
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<ItemsResp | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [edits, setEdits] = useState<Record<string, Partial<Draft>>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async (offset = 0) => {
    const qs = new URLSearchParams({ offset: String(offset), limit: String(PAGE), q: query });
    const r = await api<ItemsResp>(`/api/files/${fileId}/items?${qs}`);
    setData((prev) => (offset && prev ? { ...r, items: [...prev.items, ...r.items] } : r));
  }, [fileId, query]);
  useEffect(() => { load(0).catch((e) => setErr(e.message)); }, [load]);

  const base = (it: Item): Draft => ({ ins: rateStr(it.effective?.install_rate), sup: rateStr(it.effective?.supply_rate) });
  const items = useMemo(() => data?.items ?? [], [data]);
  const changedIds = Object.keys(edits);
  const dirty = changedIds.length;
  const invalid = changedIds.some((id) => { const e = edits[id]; return (e.ins !== undefined && bad(e.ins)) || (e.sup !== undefined && bad(e.sup)); });

  function setField(it: Item, f: keyof Draft, v: string) {
    setEdits((all) => {
      const cur = { ...(all[it.id] ?? {}), [f]: v };
      const b = base(it);
      for (const k of Object.keys(cur) as (keyof Draft)[]) if (cur[k] === b[k]) delete cur[k];
      const next = { ...all };
      if (Object.keys(cur).length) next[it.id] = cur; else delete next[it.id];
      return next;
    });
  }

  async function save() {
    if (invalid) { setErr('Fix the highlighted cells first: rates must be 0 or more.'); return; }
    setSaving(true);
    setErr(null);
    const failures: string[] = [];
    for (const id of changedIds) {
      const it = items.find((x) => x.id === id);
      const e = edits[id];
      const ov: Record<string, unknown> = {};
      if (e.ins !== undefined) ov.install_rate = parseNum(e.ins);
      if (e.sup !== undefined) ov.supply_rate = parseNum(e.sup);
      try { await api(`/api/files/${fileId}/items/${id}`, { method: 'PATCH', json: { override: ov } }); }
      catch (x) { failures.push(`${it?.item_text ?? 'Row'}: ${x instanceof Error ? x.message : x}`); }
    }
    setEdits({});
    if (failures.length) setErr(`Some changes weren’t saved. ${failures.join('; ')}`);
    await load(0).catch(() => {});
    onChanged();
    setSaving(false);
  }

  const inp: CSSProperties = { width: '100%', height: 32, padding: '0 8px', border: '1px solid transparent', borderRadius: 7, background: 'transparent', color: 'var(--ink)', font: 'inherit', fontFamily: 'var(--mono)', fontSize: 12.5, textAlign: 'right' };
  const total = data ? data.total : d.counts.price_items;

  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200, display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)' }}>
          <span style={{ color: 'var(--ink3)', fontSize: 13 }}>Search</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Item" aria-label="Search saved numbers" style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--ink)', font: 'inherit', fontSize: 14 }} />
        </div>
        <span style={{ fontSize: 12.5, color: 'var(--ink3)' }}>Showing {fmtInt(items.length)} of {fmtInt(total)} saved rates</span>
      </div>

      <div style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', overflowX: 'auto' }}>
        <div style={{ minWidth: 880 }}>
          <div style={{ display: 'grid', gridTemplateColumns: GRID, fontSize: 12, fontWeight: 600, color: 'var(--ink2)', borderBottom: '1px solid var(--line)' }}>
            <div style={{ padding: '10px 16px' }}>Item</div>
            <div style={{ padding: '10px 8px' }}>UoM</div>
            <div style={{ padding: '10px 8px', textAlign: 'right' }}>Install €/unit</div>
            <div style={{ padding: '10px 8px', textAlign: 'right' }}>Supply €/unit</div>
            <div style={{ padding: '10px 8px' }}>Basis</div>
            <div style={{ padding: '10px 8px' }}>Package</div>
            <div style={{ padding: '10px 8px' }}>Found in</div>
          </div>

          {!data && !err && <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: 'var(--ink3)', fontSize: 13.5 }}><Spinner /> Loading saved numbers…</div>}

          {items.map((it) => {
            const b = base(it), e = edits[it.id] ?? {};
            const v: Draft = { ...b, ...e };
            const changed = !!edits[it.id];
            const flags = it.flags ?? [];
            const text = String(it.effective?.item_text ?? it.item_text);
            return (
              <div key={it.id} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderBottom: '1px solid var(--line2)', background: changed ? 'var(--accSoft)' : 'transparent', fontSize: 13.5 }}>
                <div style={{ padding: '6px 8px 6px 16px', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span title={text} style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.4 }}>{text}</span>
                    {it.edited && !changed && <span title="Edited by a person; the agent uses this version" style={{ flex: 'none', fontSize: 10.5, fontWeight: 600, color: 'var(--accInk)', background: 'var(--accSoft)', padding: '1px 5px', borderRadius: 4 }}>Edited</span>}
                  </div>
                  {(it.rate_key || flags.length > 0) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
                      {it.rate_key && <span title="Rate-card item" style={{ fontSize: 12, color: 'var(--ink3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{it.rate_key}</span>}
                      {flags.map((f) => <FlagChip key={f} flag={f} />)}
                    </div>
                  )}
                </div>
                <div style={{ padding: '4px 8px', color: 'var(--ink2)', fontSize: 12.5 }}>{String(it.effective?.unit ?? it.unit ?? '—')}</div>
                <div style={{ padding: '4px 4px' }}>
                  <input value={v.ins} disabled={!canEdit} onChange={(x) => setField(it, 'ins', x.target.value)} inputMode="decimal" aria-label="Install rate, € per unit" placeholder="—"
                    className={`${styles.cellInput} ${bad(v.ins) ? styles.cellInvalid : ''}`} style={inp} />
                </div>
                <div style={{ padding: '4px 4px' }}>
                  <input value={v.sup} disabled={!canEdit} onChange={(x) => setField(it, 'sup', x.target.value)} inputMode="decimal" aria-label="Supply rate, € per unit" placeholder="—"
                    className={`${styles.cellInput} ${bad(v.sup) ? styles.cellInvalid : ''}`} style={inp} />
                </div>
                <div style={{ padding: '4px 8px', fontSize: 12.5, color: 'var(--ink2)' }}>{basisLabel(it.rate_basis, it.section_title) ?? '—'}</div>
                <div style={{ padding: '4px 8px', fontSize: 12.5, color: 'var(--ink2)' }}>{it.package ? LINE_PACKAGE[it.package] ?? it.package : '—'}</div>
                <div title={it.section_title ?? undefined} style={{ padding: '4px 8px', fontSize: 12.5, color: 'var(--ink3)', overflowWrap: 'anywhere', lineHeight: 1.4 }}>
                  {[it.sheet_name?.trim(), it.row_idx ? `row ${it.row_idx}` : null].filter(Boolean).join(' · ') || '—'}
                </div>
              </div>
            );
          })}

          {data && items.length === 0 && <div style={{ padding: 28, textAlign: 'center', color: 'var(--ink3)', fontSize: 14 }}>{query ? 'No saved rates match this search.' : 'The agent didn’t save any rates from this file.'}</div>}
          {data && data.items.length < data.total && (
            <div style={{ padding: 10, display: 'flex', justifyContent: 'center' }}>
              <button type="button" className="hv-sunk" disabled={loadingMore}
                onClick={async () => { setLoadingMore(true); await load(data.items.length).catch((x) => setErr(x.message)); setLoadingMore(false); }}
                style={{ height: 32, padding: '0 14px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {loadingMore && <Spinner size={12} />}Show {fmtInt(Math.min(PAGE, data.total - data.items.length))} more
              </button>
            </div>
          )}
        </div>
      </div>

      {err && <div role="alert" style={{ padding: '10px 14px', borderRadius: 12, background: 'var(--errSoft)', fontSize: 13.5 }}>{err}</div>}

      {dirty > 0 && (
        <div style={{ position: 'sticky', bottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', borderRadius: 12, background: 'var(--accSoft)', fontSize: 13.5, boxShadow: '0 6px 20px rgba(0,0,0,0.08)' }}>
          <span style={{ flex: 1, minWidth: 200 }}>{dirty} unsaved change{dirty === 1 ? '' : 's'}. The agent uses saved numbers only.</span>
          <button type="button" onClick={() => { setEdits({}); setErr(null); }} disabled={saving} style={{ height: 32, padding: '0 12px', border: 0, borderRadius: 8, background: 'transparent', color: 'var(--ink2)', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>Discard</button>
          <button type="button" onClick={save} disabled={saving} className="hv-accbg"
            style={{ height: 32, padding: '0 14px', border: 0, borderRadius: 8, background: 'var(--acc)', color: '#fff', font: 'inherit', fontWeight: 600, fontSize: 13, cursor: saving ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {saving && <Spinner size={12} color="#fff" />}Save changes
          </button>
        </div>
      )}
    </>
  );
}
