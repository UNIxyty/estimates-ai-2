'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/client';
import { fmtBytes, fmtInt, fmtUsd, LangTag } from '@/components/ui';
import { LANG_NAME, packageLabel, shortDate, statusLabel, tagLabel } from '../shared';
import { unitRate, type Detail } from './types';
import { longDate } from './unitRate';

function whenAnalysed(v: string | null | undefined) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return `${date}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function OverviewTab({ d, canEdit = false, onChanged }: { d: Detail; canEdit?: boolean; onChanged?: () => void }) {
  const f = d.file;
  const rows = d.sheets.reduce((a, s) => a + (s.row_count || 0), 0);
  const size = [fmtBytes(f.size_bytes), d.sheets.length ? `${d.sheets.length} sheet${d.sheets.length === 1 ? '' : 's'}` : null, rows ? `${fmtInt(rows)} rows` : null].filter(Boolean).join(' · ');
  const status = f.status === 'analysed' ? `Analysed ${whenAnalysed(f.analysed_at) ?? ''}`.trim()
    : f.status === 'analysing' ? `Analysing · ${f.progress}%` : statusLabel(f.status);
  const a = d.analysis;
  const tier = a?.tier ? a.tier[0].toUpperCase() + a.tier.slice(1) : null;
  const cost = a && a.cost_usd > 0 && a.cost_usd < 0.01 ? '<$0.01' : fmtUsd(a?.cost_usd ?? 0);
  const model = !a || a.calls === 0 ? 'No model calls · $0.00' : `${tier ?? 'Embeddings only'} · ${cost}`;
  const lang = f.language ? LANG_NAME[f.language.toUpperCase()] ?? f.language : '—';
  const facts: [string, ReactNode][] = [
    ['Type', tagLabel(f.tag)], ['Language', lang], ['Status', status],
    ['Uploaded by', f.uploaded_by_name || '—'], ['Size', size], ['Model used', model],
  ];
  const ur = unitRate(d);
  if (ur) {
    const sub = ur.subcontractor;
    const subText = [sub?.name?.value, sub?.offer_date?.value ? `offer ${sub.offer_date.value}` : null, sub?.validity?.value ? `valid to ${sub.validity.value}` : null]
      .filter(Boolean).join(' · ');
    facts.splice(1, 0,
      ['Pricing model', 'Unit rate (no hours)'],
      ['Market', <EditableFact key="m" fileId={f.id} field="market" value={f.market ?? null} canEdit={canEdit} onSaved={onChanged} />],
      ['Client', <EditableFact key="c" fileId={f.id} field="client" value={f.client ?? null} canEdit={canEdit} onSaved={onChanged} />],
      ['End client', f.end_client || '—'],
      ['Package', packageLabel(f.package)],
      ['Project', f.project || '—'],
      ['Document date', longDate(f.doc_date ?? ur.doc_date)],
    );
    if (subText) facts.splice(8, 0, ['Subcontractor', subText]);
  }
  const u = d.usedIn;
  return (
    <>
      {/* Unit-rate files have more facts than fill whole rows: the leftover slots stay panel-coloured, not grey. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 1, border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden', background: ur ? 'var(--panel)' : 'var(--line)' }}>
        {facts.map(([k, v]) => (
          <div key={k} style={{ padding: '14px 16px', background: 'var(--panel)', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, outline: ur ? '1px solid var(--line)' : undefined }}>
            <span style={{ fontSize: 12, color: 'var(--ink3)' }}>{k}</span>
            <span style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{u.total ? `Used in ${fmtInt(u.total)} estimate${u.total === 1 ? '' : 's'}` : 'Not used in any estimate yet'}</div>
        {u.total > 0 && (
          <div style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', overflow: 'hidden' }}>
            {u.mine.map((m, i) => (
              <Link key={m.conversation_id} href={`/chat/${m.conversation_id}`} className="hv-side"
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: i === u.mine.length - 1 && !u.others ? 0 : '1px solid var(--line2)', textDecoration: 'none', color: 'var(--ink)', fontSize: 14 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</span>
                <LangTag lang={m.language} />
                <span style={{ fontSize: 12.5, color: 'var(--ink3)', minWidth: 60, textAlign: 'right' }}>{shortDate(m.last_used)}</span>
              </Link>
            ))}
            {u.others > 0 && (
              <div style={{ padding: '11px 16px', fontSize: 13.5, color: 'var(--ink3)' }}>
                {u.mine.length ? 'And ' : ''}{fmtInt(u.others)} estimate{u.others === 1 ? '' : 's'} by other people
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Market (2–3 letter code) or client, edited in place by the uploader or an admin: PATCH /api/files/{id}. */
function EditableFact({ fileId, field, value, canEdit, onSaved }: {
  fileId: string; field: 'market' | 'client'; value: string | null; canEdit: boolean; onSaved?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const market = field === 'market';
  const invalid = market ? !!text.trim() && !/^[A-Za-z]{2,3}$/.test(text.trim()) : text.trim().length > 120;

  async function save() {
    const t = text.trim();
    if (invalid) { setErr(market ? 'Use a 2–3 letter country code, e.g. DE.' : 'Keep it under 120 characters.'); return; }
    if ((t || null) === (value || null)) { setEditing(false); return; }
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/files/${fileId}`, { method: 'PATCH', json: { [field]: t ? (market ? t.toUpperCase() : t) : null } });
      setEditing(false);
      onSaved?.();
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? 'Only the uploader or an admin can change this.' : e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  const linkBtn = { border: 0, padding: 0, background: 'transparent', color: 'var(--accInk)', font: 'inherit', fontSize: 12.5, cursor: 'pointer' } as const;
  if (!editing) {
    return (
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={market && value ? { fontFamily: 'var(--mono)' } : undefined}>{value || '—'}</span>
        {canEdit && <button type="button" className="hv-under" onClick={() => { setText(value ?? ''); setErr(null); setEditing(true); }} aria-label={`Edit ${field}`} style={linkBtn}>Edit</button>}
      </span>
    );
  }
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input autoFocus value={text} onChange={(e) => setText(market ? e.target.value.toUpperCase() : e.target.value)} maxLength={market ? 3 : 120}
          aria-label={market ? 'Market' : 'Client'} placeholder={market ? 'DE' : 'Main contractor'}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
          style={{ width: market ? 64 : '100%', maxWidth: 220, height: 30, padding: '0 8px', border: `1px solid ${invalid ? 'var(--err)' : 'var(--acc)'}`, borderRadius: 7, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 13.5, fontFamily: market ? 'var(--mono)' : 'inherit', outline: 0 }} />
        <button type="button" onClick={save} disabled={busy} style={{ ...linkBtn, fontWeight: 600 }}>Save</button>
        <button type="button" onClick={() => { setEditing(false); setErr(null); }} style={{ ...linkBtn, color: 'var(--ink2)' }}>Cancel</button>
      </span>
      {err && <span role="alert" style={{ fontSize: 12.5, color: 'var(--err)' }}>{err}</span>}
    </span>
  );
}
