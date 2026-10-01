'use client';

import { useState } from 'react';
import { api } from '@/lib/client';
import { fmtMoney } from '@/components/ui';
import type { Detail, Logic } from './types';

const KIND_TITLE: Record<string, string> = { rate: 'Hourly rate', labour: 'Labour', material: 'Material', subtotal: 'Subtotals', markup: 'Markup', other: 'Other' };

function titleOf(l: Logic): string {
  const n = l.effective_numbers ?? {};
  if (l.kind === 'markup' && typeof n.label === 'string') return n.label;
  if (l.kind === 'other') {
    const key = l.logic_key.split(':').pop() ?? '';
    if (key && !/^\d+$/.test(key)) return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
  return KIND_TITLE[l.kind] ?? l.kind;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const trim = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

/** Key numbers of one logic record as chips, e.g. "Hourly rate EUR 18", "Profit 5%". */
export function chipsOf(l: Logic): { k: string; v: string }[] {
  const n = l.effective_numbers ?? {};
  const cur = typeof n.currency === 'string' ? n.currency : '';
  const out: { k: string; v: string }[] = [];
  const rate = num(n.hourly_rate);
  if (rate != null) out.push({ k: 'Hourly rate', v: `${cur} ${trim(rate)}`.trim() });
  const pct = num(n.pct);
  if (pct != null) out.push({ k: typeof n.label === 'string' ? n.label : 'Markup', v: `${trim(pct * 100)}%` });
  const pctRaw = num(n.percent);
  if (pct == null && pctRaw != null) out.push({ k: 'Markup', v: `${trim(pctRaw)}%` });
  const totals = n.totals as Record<string, unknown> | undefined;
  if (totals && typeof totals === 'object') {
    const t = num(totals.total);
    if (t != null) out.push({ k: 'Total', v: fmtMoney(t, cur || null) });
    const h = num(totals.total_norm_h);
    if (h != null) out.push({ k: 'Hours', v: trim(h) });
  }
  const checked = num(n.rows_checked), matching = num(n.rows_matching);
  if (checked != null && matching != null) out.push({ k: 'Rows confirmed', v: `${matching} of ${checked}` });
  if (typeof n.formula_example === 'string' && out.length < 3) out.push({ k: 'Formula', v: n.formula_example });
  return out;
}

export function LogicTab({ d, canEdit, onChanged }: { d: Detail; canEdit: boolean; onChanged: () => void }) {
  if (!d.logic.length) {
    return <div style={{ fontSize: 14, color: 'var(--ink2)' }}>The agent didn’t find any calculation logic in this file.</div>;
  }
  return (
    <>
      <div style={{ fontSize: 14, color: 'var(--ink2)' }}>How this file calculates prices, in the agent&apos;s words. Edit anything that&apos;s wrong; the agent uses your version.</div>
      {d.logic.map((l) => <LogicCard key={l.id} fileId={d.file.id} l={l} canEdit={canEdit} onChanged={onChanged} />)}
    </>
  );
}

function LogicCard({ fileId, l, canEdit, onChanged }: { fileId: string; l: Logic; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(l.effective_sentence);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const chips = chipsOf(l);

  async function save(value: string | null) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/files/${fileId}/logic/${l.id}`, { method: 'PATCH', json: { override_sentence: value } });
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  function toggle() {
    if (!editing) { setText(l.effective_sentence); setEditing(true); return; }
    const t = text.trim();
    if (!t || t === l.effective_sentence) { setEditing(false); return; }
    save(t === l.sentence ? null : t);
  }

  const smallBtn = { height: 28, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 12.5, cursor: 'pointer' } as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16, border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{titleOf(l)}</span>
        {l.sheet_name && <span style={{ fontSize: 12.5, color: 'var(--ink3)' }}>{l.sheet_name.trim()}{l.section_title ? ` · ${l.section_title}` : ''}</span>}
        {l.edited && <span title={l.overridden_by_name ? `Edited by ${l.overridden_by_name}` : undefined} style={{ fontSize: 11, fontWeight: 600, color: 'var(--accInk)', background: 'var(--accSoft)', padding: '1px 6px', borderRadius: 4 }}>Edited</span>}
        {canEdit && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {editing && <button type="button" onClick={() => { setEditing(false); setErr(null); }} className="hv-sunk" style={{ ...smallBtn, border: 0, background: 'transparent', color: 'var(--ink2)' }}>Cancel</button>}
            {!editing && l.edited && <button type="button" onClick={() => save(null)} disabled={busy} title="Go back to the sentence the agent wrote" className="hv-sunk" style={{ ...smallBtn, border: 0, background: 'transparent', color: 'var(--ink2)' }}>Use original</button>}
            <button type="button" onClick={toggle} disabled={busy} className="hv-sunk" style={smallBtn}>{editing ? 'Save' : 'Edit'}</button>
          </span>
        )}
      </div>
      {editing
        ? <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus
            style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--acc)', borderRadius: 10, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 14.5, lineHeight: 1.55, resize: 'vertical', outline: 0 }} />
        : <div style={{ fontSize: 14.5, lineHeight: 1.6 }}>{l.effective_sentence}</div>}
      {err && <div role="alert" style={{ fontSize: 13, color: 'var(--err)' }}>{err}</div>}
      {chips.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {chips.map((n) => (
            <span key={n.k} style={{ height: 26, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 10px', borderRadius: 13, background: 'var(--sunk)', fontSize: 12.5, maxWidth: '100%' }}>
              <span style={{ color: 'var(--ink3)' }}>{n.k}</span>
              <b style={{ fontFamily: 'var(--mono)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.v}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
