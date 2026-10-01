'use client';

/**
 * "Saved numbers": the prices / norms extracted from the file as an editable table. Edits, added rows and
 * deletions are staged (changed rows highlighted) and written by "Save changes":
 * PATCH /items/{id} (override), POST /items (add), DELETE /items/{id}.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '@/lib/client';
import { useUser } from '@/components/UserContext';
import { fmtInt, Spinner } from '@/components/ui';
import styles from '../knowledge.module.css';
import type { Detail } from './types';

interface Item {
  id: string;
  sheet_name: string | null;
  row_idx: number | null;
  item_text: string;
  unit: string | null;
  attrs?: Record<string, unknown> | null;
  edited: boolean;
  effective: Record<string, unknown>;
}
interface ItemsResp { kind: 'price_items' | 'norms'; total: number; offset: number; limit: number; items: Item[] }

/** Editable fields as strings, as typed. */
interface Draft { d: string; u: string; norm: string; p: string }
interface Added extends Draft { key: string }

const PAGE = 200;
const GRID = 'minmax(220px,1fr) 70px 96px 120px 150px 40px';

function numStr(v: unknown, digits: number): string {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  // At least two decimals ("0.20", "18.80"), trailing zeros beyond that trimmed ("0.0625").
  return n.toFixed(digits).replace(/(\.\d\d\d*?)0+$/, '$1');
}
/** "1 234,5" / "1,234.5" / "0,45" → number; '' → null; garbage → NaN. */
export function parseNum(s: string): number | null {
  let t = s.trim().replace(/[\s ]/g, '');
  if (!t) return null;
  if (t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else t = t.replace(',', '.');
  return /^-?\d*\.?\d+$/.test(t) ? Number(t) : NaN;
}
const bad = (s: string) => { const n = parseNum(s); return n !== null && (Number.isNaN(n) || n < 0); };

export function NumbersTab({ d, canEdit, onChanged }: { d: Detail; canEdit: boolean; onChanged: () => void }) {
  const user = useUser();
  const fileId = d.file.id;
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<ItemsResp | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [edits, setEdits] = useState<Record<string, Partial<Draft>>>({});
  const [added, setAdded] = useState<Added[]>([]);
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async (offset = 0) => {
    const qs = new URLSearchParams({ offset: String(offset), limit: String(PAGE), q: query });
    const r = await api<ItemsResp>(`/api/files/${fileId}/items?${qs}`);
    setData((prev) => (offset && prev ? { ...r, items: [...prev.items, ...r.items] } : r));
  }, [fileId, query]);
  useEffect(() => { load(0).catch((e) => setErr(e.message)); }, [load]);

  const norms = data?.kind === 'norms';
  const currency = d.file.summary?.currency || '';
  const totalSaved = d.counts.price_items + d.counts.norms;

  const base = useCallback((it: Item): Draft => {
    const e = it.effective ?? {};
    return {
      d: String(e.item_text ?? it.item_text ?? ''),
      u: String(e.unit ?? it.unit ?? ''),
      norm: numStr(norms ? e.hours : e.norm_h_per_unit, 4),
      p: norms ? '' : numStr(e.unit_material, 2),
    };
  }, [norms]);

  const visible = useMemo(() => (data?.items ?? []).filter((it) => !deleted.has(it.id)), [data, deleted]);
  const changedIds = Object.keys(edits).filter((id) => !deleted.has(id));
  const dirty = changedIds.length + added.length + deleted.size;
  const invalid = added.some((a) => !a.d.trim() || bad(a.norm) || bad(a.p) || (norms && parseNum(a.norm) === null))
    || changedIds.some((id) => { const e = edits[id]; return (e.d !== undefined && !e.d.trim()) || (e.norm !== undefined && (bad(e.norm) || (norms && parseNum(e.norm) === null))) || (e.p !== undefined && bad(e.p)); });

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

  function discard() { setEdits({}); setAdded([]); setDeleted(new Set()); setErr(null); }

  async function save() {
    if (invalid) { setErr('Fix the highlighted cells first: every row needs an item name, and numbers must be 0 or more.'); return; }
    setSaving(true);
    setErr(null);
    const failures: string[] = [];
    for (const id of changedIds) {
      const it = data?.items.find((x) => x.id === id);
      const e = edits[id];
      const ov: Record<string, unknown> = {};
      if (e.d !== undefined) ov.item_text = e.d.trim();
      if (e.u !== undefined) ov.unit = e.u.trim() || null;
      if (e.norm !== undefined) ov[norms ? 'hours' : 'norm_h_per_unit'] = parseNum(e.norm);
      if (e.p !== undefined && !norms) ov.unit_material = parseNum(e.p);
      try { await api(`/api/files/${fileId}/items/${id}`, { method: 'PATCH', json: { override: ov } }); }
      catch (x) { failures.push(`${it?.item_text ?? 'Row'}: ${x instanceof Error ? x.message : x}`); }
    }
    for (const a of added) {
      const body: Record<string, unknown> = { item_text: a.d.trim(), unit: a.u.trim() || null };
      if (norms) body.hours = parseNum(a.norm);
      else { body.norm_h_per_unit = parseNum(a.norm); body.unit_material = parseNum(a.p); }
      try { await api(`/api/files/${fileId}/items`, { method: 'POST', json: body }); }
      catch (x) { failures.push(`${a.d}: ${x instanceof Error ? x.message : x}`); }
    }
    for (const id of deleted) {
      try { await api(`/api/files/${fileId}/items/${id}`, { method: 'DELETE' }); }
      catch (x) { failures.push(`Delete: ${x instanceof Error ? x.message : x}`); }
    }
    discard();
    if (failures.length) setErr(`Some changes weren’t saved. ${failures.join('; ')}`);
    await load(0).catch(() => {});
    onChanged();
    setSaving(false);
  }

  function foundIn(it: Item): string {
    const a = it.attrs ?? {};
    if (a.user_added) return a.added_by === user.id ? 'Added by you' : 'Added by a user';
    if (!it.sheet_name && !it.row_idx) return '—';
    return [it.sheet_name?.trim(), it.row_idx ? `row ${it.row_idx}` : null].filter(Boolean).join(' ');
  }

  const inp = (extra: CSSProperties = {}): CSSProperties => ({ width: '100%', height: 32, padding: '0 8px', border: '1px solid transparent', borderRadius: 7, background: 'transparent', color: 'var(--ink)', font: 'inherit', ...extra });
  const numInp: CSSProperties = { fontFamily: 'var(--mono)', fontSize: 12.5, textAlign: 'right' };
  const shown = visible.length + added.length;
  const total = data ? (query ? data.total : totalSaved) : totalSaved;

  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200, display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)' }}>
          <span style={{ color: 'var(--ink3)', fontSize: 13 }}>Search</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Item" aria-label="Search saved numbers" style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--ink)', font: 'inherit', fontSize: 14 }} />
        </div>
        <span style={{ fontSize: 12.5, color: 'var(--ink3)' }}>Showing {fmtInt(shown)} of {fmtInt(total)} saved numbers</span>
        {canEdit && (
          <button type="button" className="hv-sunk" onClick={() => setAdded((a) => [{ key: `n${++seq.current}`, d: '', u: norms ? 'h' : 'pcs', norm: '', p: '' }, ...a])}
            style={{ height: 36, padding: '0 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 13.5, cursor: 'pointer' }}>+ Add row</button>
        )}
      </div>

      <div style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', overflowX: 'auto' }}>
        <div style={{ minWidth: 680 }}>
          <div style={{ display: 'grid', gridTemplateColumns: GRID, fontSize: 12, fontWeight: 600, color: 'var(--ink2)', borderBottom: '1px solid var(--line)' }}>
            <div style={{ padding: '10px 16px' }}>Item</div>
            <div style={{ padding: '10px 8px' }}>Unit</div>
            <div style={{ padding: '10px 8px', textAlign: 'right' }}>Norm, h</div>
            <div style={{ padding: '10px 8px', textAlign: 'right' }}>Unit price{currency ? `, ${currency}` : ''}</div>
            <div style={{ padding: '10px 8px' }}>Found in</div>
            <div />
          </div>

          {!data && !err && <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: 'var(--ink3)', fontSize: 13.5 }}><Spinner /> Loading saved numbers…</div>}

          {added.map((a) => {
            const set = (f: keyof Draft, v: string) => setAdded((all) => all.map((x) => (x.key === a.key ? { ...x, [f]: v } : x)));
            return (
              <div key={a.key} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderBottom: '1px solid var(--line2)', background: 'var(--accSoft)', fontSize: 13.5 }}>
                <div style={{ padding: '4px 8px' }}><input autoFocus value={a.d} onChange={(e) => set('d', e.target.value)} placeholder="Item name" aria-label="Item" className={`${styles.cellInput} ${!a.d.trim() && dirty && err ? styles.cellInvalid : ''}`} style={inp()} /></div>
                <div style={{ padding: '4px 4px' }}><input value={a.u} onChange={(e) => set('u', e.target.value)} aria-label="Unit" className={styles.cellInput} style={inp({ color: 'var(--ink2)' })} /></div>
                <div style={{ padding: '4px 4px' }}><input value={a.norm} onChange={(e) => set('norm', e.target.value)} inputMode="decimal" aria-label="Norm, hours" className={`${styles.cellInput} ${bad(a.norm) ? styles.cellInvalid : ''}`} style={inp(numInp)} /></div>
                <div style={{ padding: '4px 4px' }}>{norms ? <span style={{ display: 'block', textAlign: 'right', padding: '0 8px', color: 'var(--ink3)' }}>—</span>
                  : <input value={a.p} onChange={(e) => set('p', e.target.value)} inputMode="decimal" aria-label="Unit price" className={`${styles.cellInput} ${bad(a.p) ? styles.cellInvalid : ''}`} style={inp(numInp)} />}</div>
                <div style={{ padding: '4px 8px', fontSize: 12.5, color: 'var(--ink3)' }}>Added by you</div>
                <div><button type="button" title="Delete" aria-label="Delete row" className={styles.delBtn} onClick={() => setAdded((all) => all.filter((x) => x.key !== a.key))} style={{ width: 28, height: 28, border: 0, borderRadius: 7, background: 'transparent', color: 'var(--ink3)', fontSize: 15, cursor: 'pointer' }}>×</button></div>
              </div>
            );
          })}

          {visible.map((it) => {
            const b = base(it), e = edits[it.id] ?? {};
            const v: Draft = { ...b, ...e };
            const changed = !!edits[it.id];
            return (
              <div key={it.id} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderBottom: '1px solid var(--line2)', background: changed ? 'var(--accSoft)' : 'transparent', fontSize: 13.5 }}>
                <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input value={v.d} disabled={!canEdit} onChange={(x) => setField(it, 'd', x.target.value)} aria-label="Item" title={v.d}
                    className={`${styles.cellInput} ${e.d !== undefined && !e.d.trim() ? styles.cellInvalid : ''}`} style={inp({ flex: 1, minWidth: 0 })} />
                  {it.edited && !changed && <span title="Edited by a person; the agent uses this version" style={{ flex: 'none', fontSize: 10.5, fontWeight: 600, color: 'var(--accInk)', background: 'var(--accSoft)', padding: '1px 5px', borderRadius: 4 }}>Edited</span>}
                </div>
                <div style={{ padding: '4px 4px' }}><input value={v.u} disabled={!canEdit} onChange={(x) => setField(it, 'u', x.target.value)} aria-label="Unit" className={styles.cellInput} style={inp({ color: 'var(--ink2)' })} /></div>
                <div style={{ padding: '4px 4px' }}><input value={v.norm} disabled={!canEdit} onChange={(x) => setField(it, 'norm', x.target.value)} inputMode="decimal" aria-label="Norm, hours"
                  className={`${styles.cellInput} ${bad(v.norm) ? styles.cellInvalid : ''}`} style={inp(numInp)} /></div>
                <div style={{ padding: '4px 4px' }}>{norms ? <span style={{ display: 'block', textAlign: 'right', padding: '0 8px', color: 'var(--ink3)' }}>—</span>
                  : <input value={v.p} disabled={!canEdit} onChange={(x) => setField(it, 'p', x.target.value)} inputMode="decimal" aria-label="Unit price"
                      className={`${styles.cellInput} ${bad(v.p) ? styles.cellInvalid : ''}`} style={inp(numInp)} />}</div>
                <div style={{ padding: '4px 8px', fontSize: 12.5, color: 'var(--ink3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{foundIn(it)}</div>
                <div>{canEdit && <button type="button" title="Delete" aria-label="Delete row" className={styles.delBtn}
                  onClick={() => setDeleted((s) => new Set(s).add(it.id))}
                  style={{ width: 28, height: 28, border: 0, borderRadius: 7, background: 'transparent', color: 'var(--ink3)', fontSize: 15, cursor: 'pointer' }}>×</button>}</div>
              </div>
            );
          })}

          {data && shown === 0 && <div style={{ padding: 28, textAlign: 'center', color: 'var(--ink3)', fontSize: 14 }}>{query ? 'No saved numbers match this search.' : 'The agent didn’t save any numbers from this file.'}</div>}
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
          <button type="button" onClick={discard} disabled={saving} style={{ height: 32, padding: '0 12px', border: 0, borderRadius: 8, background: 'transparent', color: 'var(--ink2)', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>Discard</button>
          <button type="button" onClick={save} disabled={saving} className="hv-accbg"
            style={{ height: 32, padding: '0 14px', border: 0, borderRadius: 8, background: 'var(--acc)', color: '#fff', font: 'inherit', fontWeight: 600, fontSize: 13, cursor: saving ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {saving && <Spinner size={12} color="#fff" />}Save changes
          </button>
        </div>
      )}
    </>
  );
}
