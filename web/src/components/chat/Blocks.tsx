'use client';

/** Agent message blocks from design/Message.dc.html: rich text with chips, working steps, document card, web prices. */
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { fmtInt, fmtMoney, fmtWhen, KindText, LangTag, MONO } from '@/components/ui';
import { useChat } from './context';
import type { Doc, Part, Step } from './types';
import s from './Chat.module.css';

/* ------------------------------------------------------------------ rich text */

type Inline =
  | { k: 'text'; t: string }
  | { k: 'bold'; t: string }
  | { k: 'row'; docId?: string; sheet: string | null; row: number }
  | { k: 'file'; fileId: string; name: string; sheet?: string | null; row?: number | null };
interface Para { tone?: 'warn'; items: Inline[] }

/** "**bold**" inside plain text. */
function inlineText(t: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let pos = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    if (m.index > pos) out.push({ k: 'text', t: t.slice(pos, m.index) });
    out.push({ k: 'bold', t: m[1] });
    pos = m.index + m[0].length;
  }
  if (pos < t.length) out.push({ k: 'text', t: t.slice(pos) });
  return out;
}

/**
 * Structured parts → paragraphs. Newlines split paragraphs; a text part that follows another text part, or a
 * label ending in ":" after chips (the summary's "Please check …:" lists), also starts one.
 */
export function partsToParas(parts: Part[]): Para[] {
  const paras: Para[] = [{ items: [] }];
  let prev: 'text' | 'chip' | null = null;
  const cur = () => paras[paras.length - 1];
  const newPara = () => { if (cur().items.length) paras.push({ items: [] }); };
  for (const p of parts) {
    if (p.type === 'text') {
      const text = String((p as { text?: string }).text ?? '');
      if (prev === 'text' || (prev === 'chip' && /:\s*$/.test(text))) newPara();
      if ((p as { tone?: string }).tone === 'warn') { newPara(); cur().tone = 'warn'; }
      const lines = text.split(/\n+/);
      lines.forEach((line, i) => {
        if (i > 0) newPara();
        if (line) cur().items.push(...inlineText(line));
      });
      prev = 'text';
    } else if (p.type === 'chip') {
      const c = p as any;
      if (c.kind === 'row') cur().items.push({ k: 'row', docId: c.document_id, sheet: c.sheet ?? null, row: Number(c.row) });
      else if (c.kind === 'file') cur().items.push({ k: 'file', fileId: c.file_id, name: c.label || 'file', sheet: c.sheet, row: c.row });
      prev = 'chip';
    }
  }
  return paras.filter((x) => x.items.some((i) => i.k !== 'text' || i.t.trim()));
}

/** While an answer streams, its text still holds the [[row:…]] / [[file:…]] markers: show them as chips. */
export function streamingParts(text: string, latestDocId?: string, fileName?: (id: string) => string | undefined): Part[] {
  const out: Part[] = [];
  const re = /\[\[(row|file):([^\]]+)\]\]/g;
  let pos = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > pos) out.push({ type: 'text', text: text.slice(pos, m.index) });
    const ref = m[2].trim();
    if (m[1] === 'row') {
      const i = ref.lastIndexOf('!');
      const row = Number(ref.slice(i + 1));
      if (Number.isFinite(row)) out.push({ type: 'chip', kind: 'row', document_id: latestDocId ?? '', sheet: i > 0 ? ref.slice(0, i) : null, row });
    } else {
      const [id, sheet, row] = ref.split('!');
      out.push({ type: 'chip', kind: 'file', file_id: id, label: fileName?.(id) || 'file', sheet: sheet || null, row: row ? Number(row) : null });
    }
    pos = m.index + m[0].length;
  }
  // Hide a marker that is still being typed.
  const rest = text.slice(pos).replace(/\[\[[^\]]*$/, '');
  if (rest) out.push({ type: 'text', text: rest });
  return out;
}

export function rowLabel(sheet: string | null | undefined, row: number) {
  return sheet ? `${sheet} · row ${row}` : `Row ${row}`;
}

export function RowChip({ sheet, row, onClick, small }: { sheet: string | null | undefined; row: number; onClick?: () => void; small?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={s.rowChip}
      style={{ display: 'inline-flex', alignItems: 'center', height: 24, padding: '0 8px', margin: small ? 0 : '0 1px', border: 0, borderRadius: 6, background: 'var(--accSoft)', color: 'var(--accInk)', fontFamily: 'inherit', fontSize: small ? 12 : 13, fontWeight: 500, verticalAlign: 1, cursor: 'pointer', whiteSpace: 'nowrap' }}>
      {rowLabel(sheet, row)}
    </button>
  );
}

export function FileChip({ name, onClick }: { name: string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className="hv-line"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 8px', margin: '0 1px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--panel)', color: 'var(--ink)', fontFamily: 'inherit', fontSize: 13, verticalAlign: 1, cursor: 'pointer', whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      <KindText name={name} style={{ fontSize: 9 }} />{name}
    </button>
  );
}

export function RichText({ parts }: { parts: Part[] }) {
  const { openDocument, openFile, files } = useChat();
  const paras = partsToParas(parts);
  if (!paras.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, textWrap: 'pretty' } as React.CSSProperties}>
      {paras.map((p, i) => (
        <div key={i} style={{ color: p.tone === 'warn' ? 'var(--warn)' : 'var(--ink)', overflowWrap: 'anywhere' }}>
          {p.items.map((x, j) => {
            if (x.k === 'text') return <Fragment key={j}>{x.t}</Fragment>;
            if (x.k === 'bold') return <b key={j} style={{ fontWeight: 600 }}>{x.t}</b>;
            if (x.k === 'row') return <RowChip key={j} sheet={x.sheet} row={x.row} onClick={() => x.docId && openDocument(x.docId, { sheet: x.sheet, row: x.row })} />;
            const name = files[x.fileId]?.original_name || x.name;
            return <FileChip key={j} name={name} onClick={() => openFile(x.fileId, name, x.row ? { sheet: x.sheet, row: x.row } : undefined)} />;
          })}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ working steps */

export type StepsStatus = 'running' | 'waiting' | 'done' | 'cancelled' | 'failed';

export function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} s`;
  return `${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, '0')} s`;
}

export function SpinnerRing({ size = 16 }: { size?: number }) {
  return <span aria-hidden style={{ width: size, height: size, flex: 'none', borderRadius: '50%', border: '2px solid var(--accSoft)', borderTopColor: 'var(--acc)', animation: 'spin .8s linear infinite', boxSizing: 'border-box' }} />;
}

export function StepsBlock({ steps, status, startedAt, endedAt, onStop, docId }: {
  steps: Step[]; status: StepsStatus; startedAt: number; endedAt?: number; onStop?: () => void; docId?: string;
}) {
  const { openDocument } = useChat();
  const [open, setOpen] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const live = status === 'running';
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  const isOpen = open ?? status !== 'done';
  const n = steps.length;
  // While running, the header names the step in progress (with its counter) instead of a generic "Working…".
  const current = live ? [...steps].reverse().find((x) => x.state === 'running') : undefined;
  const title = status === 'running' ? (current ? `${current.label || 'Working'}${current.total ? ` · ${fmtInt(current.done ?? 0)} / ${fmtInt(current.total)}` : '…'}` : 'Working…')
    : status === 'waiting' ? 'Paused: waiting for your answer'
    : status === 'cancelled' ? `Stopped after ${n} step${n === 1 ? '' : 's'}` : status === 'failed' ? `Failed after ${n} step${n === 1 ? '' : 's'}`
    : `Finished ${n} step${n === 1 ? '' : 's'}`;
  const elapsed = fmtElapsed((live ? Math.max(now, endedAt ?? 0) : endedAt ?? startedAt) - startedAt);

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--panel)', fontSize: 13.5, lineHeight: 1.45 }}>
      <button type="button" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', border: 0, background: 'transparent', color: 'var(--ink)', font: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
        {live && <SpinnerRing />}
        {status === 'done' && <span style={{ width: 16, height: 16, flex: 'none', borderRadius: '50%', background: 'var(--ok)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9 }}>✓</span>}
        {status === 'waiting' && <span style={{ width: 16, height: 16, flex: 'none', borderRadius: '50%', border: '2px solid var(--warn)', boxSizing: 'border-box' }} />}
        {(status === 'cancelled' || status === 'failed') && <span style={{ width: 16, height: 16, flex: 'none', borderRadius: '50%', background: status === 'failed' ? 'var(--err)' : 'var(--ink3)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700 }}>{status === 'failed' ? '!' : '■'}</span>}
        <span className={live ? s.shimmer : undefined} style={{ fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <span style={{ color: 'var(--ink3)', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{elapsed}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--ink3)', fontSize: 12.5, whiteSpace: 'nowrap' }}>{isOpen ? 'Hide steps' : 'Show steps'}</span>
      </button>
      {isOpen && (
        <div style={{ borderTop: '1px solid var(--line2)', padding: '8px 14px 12px', display: 'flex', flexDirection: 'column' }}>
          {steps.map((st) => {
            const warn = st.warns.length > 0;
            const running = st.state === 'running';
            const kind: 'done' | 'active' | 'warn' | 'todo' = warn ? 'warn'
              : !running ? 'done'
              : status === 'running' || status === 'waiting' ? 'active'
              : status === 'done' ? 'done' : 'todo';
            const col = kind === 'done' ? 'var(--ok)' : kind === 'active' ? 'var(--acc)' : kind === 'warn' ? 'var(--warn)' : 'var(--ink3)';
            const label = st.label || st.warns[0]?.message || st.step_id;
            const counter = running && st.total ? `${fmtInt(st.done ?? 0)} / ${fmtInt(st.total)}` : '';
            const summary = st.summary || '';
            const meta = counter || (summary.length <= 32 ? summary : '') || (!running && st.total ? `${fmtInt(st.total)} rows` : '');
            const subs: ReactNode[] = [];
            if (st.current && running) subs.push(`Now: ${st.current}`);
            if (summary.length > 32) subs.push(summary);
            for (const w of st.warns) if (w.message !== label) subs.push(w.message);
            const rows = st.warns.flatMap((w) => w.rows || []).slice(0, 8);
            const pct = running && (status === 'running') && st.total ? Math.min(100, Math.round(((st.done ?? 0) / st.total) * 100)) : null;
            return (
              <div key={st.step_id} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0,1fr) auto', gap: 10, alignItems: 'start', padding: '5px 0' }}>
                <span style={{ width: 8, height: 8, marginTop: 6, justifySelf: 'center', borderRadius: '50%', background: kind === 'todo' ? 'transparent' : col, border: `1.5px solid ${col}`, boxSizing: 'border-box' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                  <span style={{ color: kind === 'todo' ? 'var(--ink3)' : 'var(--ink)', fontWeight: kind === 'active' ? 500 : 400 }}>{label}</span>
                  {pct != null && (
                    <div style={{ height: 4, borderRadius: 2, background: 'var(--sunk)', overflow: 'hidden', maxWidth: 320 }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: 'var(--acc)', transition: 'width .4s' }} />
                    </div>
                  )}
                  {subs.map((x, i) => <span key={i} style={{ fontSize: 12, color: 'var(--ink3)' }}>{x}</span>)}
                  {rows.length > 0 && (
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {rows.map((r, i) => <RowChip key={i} small sheet={r.sheet} row={r.row} onClick={docId ? () => openDocument(docId, { sheet: r.sheet, row: r.row }) : undefined} />)}
                    </span>
                  )}
                </div>
                <span style={{ fontFamily: MONO, fontSize: 11.5, color: kind === 'warn' ? 'var(--warn)' : 'var(--ink3)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{meta}</span>
              </div>
            );
          })}
          {live && onStop && (
            <div style={{ display: 'flex', gap: 8, paddingTop: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={onStop} className="hv-sunk"
                style={{ height: 28, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel)', color: 'var(--ink2)', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}>Stop</button>
              <span style={{ fontSize: 12, color: 'var(--ink3)', alignSelf: 'center' }}>You can leave this page. The agent keeps working.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ document card */

export function DocCard({ docId, payload }: { docId: string; payload: any }) {
  const { docs, openDocument } = useChat();
  const d: Partial<Doc> = { ...(payload || {}), ...(docs[docId] || {}) };
  const name = d.name || payload?.name || 'Estimate.xlsx';
  const t = d.totals || payload?.totals || {};
  const sheets: string[] = Array.isArray(payload?.sheets) ? payload.sheets : [];
  const attention = Number(t.check || 0) + Number(t.no_price || 0);
  const meta = [
    sheets.length ? `${sheets.length} sheet${sheets.length === 1 ? '' : 's'}` : null,
    t.rows != null ? `${fmtInt(t.rows)} rows` : null,
    attention ? `${fmtInt(attention)} row${attention === 1 ? ' needs' : 's need'} attention` : `generated ${fmtWhen(d.updated_at || d.created_at)}`,
    (d.version ?? 1) > 1 ? `version ${d.version}` : null,
  ].filter(Boolean).join(' · ');
  const open = () => openDocument(docId, undefined, name);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 14, border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', flexWrap: 'wrap', maxWidth: 560 }}>
      <button type="button" onClick={open} style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 220, border: 0, padding: 0, background: 'transparent', font: 'inherit', color: 'var(--ink)', textAlign: 'left', cursor: 'pointer' }}>
        <span style={{ width: 40, height: 48, flex: 'none', borderRadius: 7, background: 'var(--okSoft)', color: 'var(--ok)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 10, fontWeight: 600 }}>XLSX</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 3, lineHeight: 1.3, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            <LangTag lang={d.language} />
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--ink3)' }}>{meta}</span>
        </span>
      </button>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" onClick={open} className="hv-sunk"
          style={{ height: 34, padding: '0 14px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Open</button>
        <a href={`/api/documents/${docId}/download`} className="hv-accbg"
          style={{ height: 34, display: 'inline-flex', alignItems: 'center', padding: '0 14px', borderRadius: 9, background: 'var(--acc)', color: '#fff', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>Download .xlsx</a>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ web-sourced prices */

const hostOf = (u?: string | null) => {
  try { return u ? new URL(u).hostname.replace(/^www\./, '') : ''; } catch { return u || ''; }
};

export function WebPrices({ payload }: { payload: any }) {
  const { openDocument } = useChat();
  const [all, setAll] = useState(false);
  const rows: any[] = Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload?.items) ? payload.items : [];
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, 5);
  const cols = 'minmax(200px,1.6fr) 96px 56px 100px 130px 124px';
  const num = (v: unknown, cur?: string) => (v == null ? '—' : fmtMoney(v, cur, 2));
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--panel)', overflow: 'hidden', fontSize: 13, lineHeight: 1.4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 600, color: 'var(--web)', background: 'var(--webSoft)', padding: '2px 5px', borderRadius: 3 }}>WEB</span>
        <span style={{ fontWeight: 600 }}>Web-sourced prices</span>
        <span style={{ color: 'var(--ink3)', fontSize: 12.5 }}>{rows.length} row{rows.length === 1 ? '' : 's'} · check these before sending</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 680 }}>
          <div style={{ display: 'grid', gridTemplateColumns: cols, fontSize: 12, fontWeight: 600, color: 'var(--ink2)', borderBottom: '1px solid var(--line2)' }}>
            <div style={{ padding: '8px 14px' }}>Product</div><div style={{ padding: 8, textAlign: 'right' }}>Unit price</div><div style={{ padding: 8, textAlign: 'right' }}>Qty</div>
            <div style={{ padding: 8, textAlign: 'right' }}>Total</div><div style={{ padding: 8 }}>Source</div><div style={{ padding: '8px 14px 8px 8px' }}>Location</div>
          </div>
          {shown.map((w, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', borderBottom: '1px solid var(--line2)', fontVariantNumeric: 'tabular-nums' }}>
              <div title={w.product || w.query} style={{ padding: '8px 14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.product || w.query || '—'}</div>
              <div style={{ padding: 8, textAlign: 'right', fontFamily: MONO, fontSize: 12 }}>{num(w.unit_price, w.currency)}</div>
              <div style={{ padding: 8, textAlign: 'right', fontFamily: MONO, fontSize: 12 }}>{w.qty == null ? '—' : fmtInt(w.qty)}</div>
              <div style={{ padding: 8, textAlign: 'right', fontFamily: MONO, fontSize: 12 }}>{num(w.total, w.currency)}</div>
              <div style={{ padding: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {w.url ? <a href={w.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accInk)' }}>{hostOf(w.url)}</a> : '—'}
              </div>
              <div style={{ padding: '6px 14px 6px 8px' }}>
                {w.row != null && <RowChip small sheet={w.sheet} row={Number(w.row)} onClick={() => payload?.document_id && openDocument(payload.document_id, { sheet: w.sheet, row: Number(w.row) })} />}
              </div>
            </div>
          ))}
        </div>
      </div>
      {rows.length > 5 && (
        <button type="button" onClick={() => setAll(!all)} className="hv-sunk"
          style={{ width: '100%', height: 36, border: 0, background: 'transparent', color: 'var(--accInk)', font: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
      {payload?.note && <div style={{ padding: '8px 14px', borderTop: rows.length > 5 ? '1px solid var(--line2)' : 0, fontSize: 12, color: 'var(--ink3)' }}>{payload.note}</div>}
    </div>
  );
}
