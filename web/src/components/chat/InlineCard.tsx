'use client';

/**
 * design/InlineCard.dc.html (DESIGN.md §5.4): permission, structure proposal, clarifying questions, email and
 * cost cap cards, every state. Each button POSTs /api/cards/{id}/decision (idempotent server-side, state-guarded)
 * and shows the card the server returns; later transitions arrive as card.updated events.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/client';
import { fmtUsd, MONO } from '@/components/ui';
import { useChat } from './context';
import { DocCard, WebPrices } from './Blocks';
import type { Card } from './types';

type PillKey = 'pending' | 'approved' | 'denied' | 'expired' | 'done' | 'failed' | 'sending' | 'changed' | 'stopped';
const PILL: Record<PillKey, [string, string, string]> = {
  pending: ['Waiting for you', 'var(--accInk)', 'var(--accSoft)'],
  approved: ['Approved', 'var(--ok)', 'var(--okSoft)'],
  denied: ['Denied', 'var(--ink2)', 'var(--sunk)'],
  expired: ['Expired', 'var(--ink3)', 'var(--sunk)'],
  done: ['Done', 'var(--ok)', 'var(--okSoft)'],
  failed: ['Failed', 'var(--err)', 'var(--errSoft)'],
  sending: ['Sending', 'var(--accInk)', 'var(--accSoft)'],
  changed: ['Changed', 'var(--ink2)', 'var(--sunk)'],
  stopped: ['Stopped', 'var(--ink2)', 'var(--sunk)'],
};
const LABEL: Record<string, string> = {
  permission: 'Permission needed', structure: 'Proposed structure', clarify: 'A few questions', email: 'Email', cost_cap: 'Cost limit reached',
};
export const LANGS: [string, string][] = [
  ['LV', 'Latvian'], ['EN', 'English'], ['DA', 'Danish'], ['LT', 'Lithuanian'], ['ET', 'Estonian'], ['SV', 'Swedish'],
  ['NO', 'Norwegian'], ['FI', 'Finnish'], ['DE', 'German'], ['PL', 'Polish'],
];
const langName = (c?: string | null) => LANGS.find((l) => l[0] === (c || '').toUpperCase())?.[1] ?? (c || 'the template language');

const btnPrimary: React.CSSProperties = { height: 36, padding: '0 16px', border: 0, borderRadius: 9, background: 'var(--acc)', color: '#fff', font: 'inherit', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' };
const btnSecondary: React.CSSProperties = { height: 36, padding: '0 14px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 13.5, fontWeight: 500, cursor: 'pointer' };

function Spin() {
  return <span aria-hidden style={{ width: 20, height: 20, flex: 'none', borderRadius: '50%', border: '2px solid var(--accSoft)', borderTopColor: 'var(--acc)', animation: 'spin .8s linear infinite', boxSizing: 'border-box' }} />;
}

function rowsSummary(rows: { sheet?: string; row?: number }[], total: number): string {
  const by = new Map<string, number[]>();
  for (const r of rows.slice(0, 12)) {
    const k = r.sheet || '';
    by.set(k, [...(by.get(k) || []), Number(r.row)]);
  }
  const list = [...by.entries()].map(([sh, ns]) => `${sh ? `${sh} ` : 'row '}${ns.join(', ')}`).join(' · ');
  const more = total > 12 ? ` and ${total - 12} more` : '';
  return `Affects ${total} row${total === 1 ? '' : 's'}: ${list}${more}`;
}

/** "Resend 422: {\"message\": \"Invalid `to` field…\"}" → "Invalid `to` field…". */
function readableError(e: string): string {
  const i = e.indexOf('{');
  let out = e;
  if (i >= 0) {
    try {
      const j = JSON.parse(e.slice(i));
      if (typeof j?.message === 'string') out = j.message;
    } catch {}
  }
  return out.trim().replace(/\.?$/, '.');
}

const fmtStamp = (v?: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};

export function InlineCard({ card }: { card: Card }) {
  if (card.kind === 'document') return card.payload?.document_id ? <DocCard docId={card.payload.document_id} payload={card.payload} /> : null;
  if (card.kind === 'web_prices') return <WebPrices payload={card.payload} />;
  return <DecisionCard card={card} />;
}

function DecisionCard({ card }: { card: Card }) {
  const { onCard, followRun, runs, openFile, openDocument, files } = useChat();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [undoUntil, setUndoUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const p = card.payload || {};
  const run = runs[card.run_id];

  // Expiry (permission cards) and the Undo window are time-based: re-render every second while relevant.
  const expiresAt = card.expires_at ? Date.parse(card.expires_at) : null;
  const decidedAt = card.decided_at ? Date.parse(card.decided_at) : null;
  const undoEnd = undoUntil ?? (decidedAt ? decidedAt + 10_000 : null);
  const ticking = (card.status === 'pending' && expiresAt != null) || (undoEnd != null && undoEnd > now);
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  async function decide(action: string, data?: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ card: Card; undo_seconds?: number }>(`/api/cards/${card.id}/decision`, { method: 'POST', json: { action, data } });
      onCard(r.card);
      if ((action === 'allow' || action === 'deny') && r.card.decided_at) setUndoUntil(Date.parse(r.card.decided_at) + (r.undo_seconds ?? 10) * 1000);
      if (action !== 'undo' && action !== 'ask_again') followRun(card.run_id);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.body.card) onCard(e.body.card as Card);
        setMsg(e.body.error === 'expired' ? 'This request expired. Ask again?' : e.body.error === 'too_late' ? 'Too late to undo: the agent already continued.' : e.message);
      } else setMsg('Request failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const expired = card.status === 'expired' || (card.status === 'pending' && expiresAt != null && expiresAt <= now);
  let pill: PillKey = 'pending';
  let body: ReactNode = null;
  let footer = '';
  let canUndo = false;
  let canReask = false;
  let content: ReactNode = null;
  let actions: ReactNode = null;

  /* ---------------- permission */
  if (card.kind === 'permission') {
    const fileId = p.file_id ?? p.ref_file_id;
    const fname = p.file_name || files[fileId]?.original_name || 'another file';
    const rows: { sheet?: string; row?: number; item?: string }[] = Array.isArray(p.rows) ? p.rows : [];
    const total = Number(p.row_count ?? rows.length);
    const custom = typeof p.reason === 'string' && p.reason && !/^The closest prices for/.test(p.reason);
    const fileLink = (
      <button type="button" onClick={() => openFile(fileId, fname)} className="hv-under"
        style={{ border: 0, padding: 0, background: 'transparent', font: 'inherit', fontWeight: 600, color: 'inherit', cursor: 'pointer' }}>'{fname}'</button>
    );
    body = (
      <>
        <div>
          {custom ? <>{p.reason} Can I use {fileLink}?</> : <>Prices for {total === 1 ? 'this row aren\'t' : `${total} rows aren't`} in your selected references. I found them in {fileLink}. Can I use it?</>}
        </div>
        {rows.length > 0 && <div style={{ fontSize: 12.5, color: 'var(--ink3)' }}>{rowsSummary(rows, total)}</div>}
      </>
    );
    const resumed = run && ['running', 'done'].includes(run.status) && undoEnd != null && undoEnd <= now && (!run.finished_at || !decidedAt || Date.parse(run.finished_at) > decidedAt);
    if (expired) {
      pill = 'expired';
      footer = 'This request expired. The estimate was finished without these prices.';
      canReask = true;
    } else if (card.status === 'approved') {
      pill = resumed && run?.status === 'done' ? 'done' : 'approved';
      footer = p.cross_model ? `Allowed: its € per unit are used as unit rates, each line marked CHECK.`
        : pill === 'done' ? `Used ${fname} for ${total} row${total === 1 ? '' : 's'}.` : `Allowed for this estimate. ${fname} is now a reference.`;
    } else if (card.status === 'denied') {
      pill = 'denied';
      footer = p.cross_model ? 'Denied. Lines without a unit-rate reference stay without a price.'
        : resumed && run?.status === 'done' ? 'Denied. Searched supplier websites instead.' : 'Denied. Searching supplier websites instead.';
    }
    canUndo = (card.status === 'approved' || card.status === 'denied') && undoEnd != null && undoEnd > now;
    if (card.status === 'pending' && !expired)
      actions = (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 16px 16px' }}>
          <button type="button" disabled={busy} onClick={() => decide('allow')} className="hv-accbg" style={btnPrimary}>Allow for this estimate</button>
          <button type="button" disabled={busy} onClick={() => decide('deny')} className="hv-sunk" style={btnSecondary}>Deny: search the web instead</button>
        </div>
      );
  }

  /* ---------------- structure */
  if (card.kind === 'structure') {
    pill = card.status === 'pending' ? 'pending' : card.status === 'generating' ? 'approved' : card.status === 'done' ? 'done' : card.status === 'changed' ? 'changed' : 'expired';
    const lang = (card.decision?.data?.language as string) || p.language;
    footer = {
      generating: `Generating with ${p.template_name} as the template, in ${langName(lang)}.`,
      done: `Estimate generated from ${p.template_name}.`,
      changed: 'You asked for changes. The revised structure is below.',
      replaced: 'Replaced by a newer proposal below.',
    }[card.status as string] || '';
    if (card.status === 'generating' && run && (run.status === 'failed' || run.status === 'cancelled')) {
      pill = run.status === 'failed' ? 'failed' : 'stopped';
      footer = run.status === 'failed' ? 'Generation stopped because the run failed. See the message below.' : 'Generation was stopped.';
    }
    body = <div>I&apos;ll build this like <b style={{ fontWeight: 600 }}>&apos;{p.template_name}&apos;</b>, the reference closest to your work list.</div>;
    if (card.status === 'pending') content = <StructurePending card={card} busy={busy} decide={decide} />;
  }

  /* ---------------- clarify */
  if (card.kind === 'clarify') {
    pill = card.status === 'pending' ? 'pending' : card.status === 'answered' ? 'done' : 'expired';
    footer = card.status === 'answered' ? 'Answers sent.' : card.status === 'expired' ? 'Expired. You sent a new message instead.' : '';
    body = p.purpose === 'unit_rate_setup'
      ? <div>This is a unit-rate BOQ: every line is quantity × rate, with no hours and no hourly rate. Confirm the programme, the packages and the offer details.</div>
      : p.purpose === 'confirm_setup'
      ? <div>Before I price this blank: confirm the hourly rate{Array.isArray(p.questions) && p.questions.some((q: { id?: string }) => q.id === 'sheets') ? ' and which sheets to price' : ''}. Every labour row uses this rate.</div>
      : p.purpose === 'confirm_sheets'
        ? <div>I&apos;m not sure which sheets hold the electrical works. Pick them and I&apos;ll start.</div>
        : <div>The work list is too short to price reliably. A few quick answers and I can start.</div>;
    content = <ClarifyBody card={card} busy={busy} decide={decide} />;
  }

  /* ---------------- email */
  if (card.kind === 'email') {
    const st = card.status === 'done' ? 'done' : card.status === 'failed' ? 'failed' : 'sending';
    pill = st;
    const doc = p.document_name || 'the estimate';
    const [title, sub] = st === 'sending'
      ? [`Sending ${doc} to ${p.to}…`, 'This usually takes a few seconds']
      : st === 'done' ? [`Sent to ${p.to}: ${doc}`, fmtStamp(card.updated_at || card.decided_at || card.created_at)]
      : [`Couldn't send ${doc}`, `${p.error ? readableError(String(p.error)) : 'The mail server didn\'t respond.'} Nothing was sent.`];
    content = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px 14px' }}>
        {st === 'sending' && <Spin />}
        {st === 'done' && <span style={{ width: 22, height: 22, flex: 'none', borderRadius: '50%', background: 'var(--ok)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>✓</span>}
        {st === 'failed' && <span style={{ width: 22, height: 22, flex: 'none', borderRadius: '50%', background: 'var(--err)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}>!</span>}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{ overflowWrap: 'anywhere' }}>
            {st === 'done' && p.document_id ? <>Sent to {p.to}: <button type="button" className="hv-under" onClick={() => openDocument(p.document_id, undefined, doc)} style={{ border: 0, padding: 0, background: 'transparent', font: 'inherit', color: 'inherit', cursor: 'pointer' }}>{doc}</button></> : title}
          </span>
          <span style={{ fontSize: 12.5, color: st === 'failed' ? 'var(--err)' : 'var(--ink3)', overflowWrap: 'anywhere' }}>{sub}</span>
        </div>
        {st === 'failed' && <button type="button" disabled={busy} onClick={() => decide('retry')} className="hv-accbg" style={{ ...btnPrimary, height: 34, padding: '0 14px' }}>Retry</button>}
      </div>
    );
  }

  /* ---------------- cost cap */
  if (card.kind === 'cost_cap') {
    pill = card.status === 'pending' ? 'pending' : card.status === 'continued' ? 'done' : 'stopped';
    footer = card.status === 'continued' ? 'Continued with a higher limit for this run.' : card.status === 'stopped' ? 'Stopped. Nothing more was spent.' : '';
    body = <div>This run has cost <span style={{ fontFamily: MONO }}>{fmtUsd(p.run_cost_usd)}</span>, which reaches its limit of <span style={{ fontFamily: MONO }}>{fmtUsd(p.cap_usd)}</span>. Should I continue?</div>;
    if (card.status === 'pending')
      actions = (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 16px 16px' }}>
          <button type="button" disabled={busy} onClick={() => decide('continue')} className="hv-accbg" style={btnPrimary}>Continue</button>
          <button type="button" disabled={busy} onClick={() => decide('stop')} className="hv-sunk" style={btnSecondary}>Stop here</button>
        </div>
      );
  }

  const pending = pill === 'pending' && card.kind !== 'email';
  const [pl, pfg, pbg] = PILL[pill];
  return (
    <div data-card-kind={card.kind} data-card-status={card.status}
      style={{ width: '100%', border: `1px solid ${pending ? 'var(--acc)' : pill === 'failed' ? 'var(--err)' : 'var(--line)'}`, borderRadius: 14, background: 'var(--panel)', fontSize: 14, lineHeight: 1.5, color: 'var(--ink)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px 0' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink2)' }}>{(card.kind === 'permission' && p.title) || (LABEL[card.kind] ?? card.kind)}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 11, fontSize: 11.5, fontWeight: 500, color: pfg, background: pbg, whiteSpace: 'nowrap' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />{pl}
        </span>
      </div>
      {body && (
        <div style={{ padding: card.kind === 'permission' ? '8px 16px 14px' : card.kind === 'clarify' ? '8px 16px 4px' : '8px 16px 12px', display: 'flex', flexDirection: 'column', gap: 6, color: pending || card.kind === 'email' ? 'var(--ink)' : 'var(--ink2)' }}>{body}</div>
      )}
      {content}
      {actions}
      {msg && <div role="alert" style={{ padding: '0 16px 12px', fontSize: 12.5, color: 'var(--err)' }}>{msg}</div>}
      {footer && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderTop: '1px solid var(--line2)', background: 'var(--side)', fontSize: 13, color: 'var(--ink2)' }}>
          <span style={{ flex: 1 }}>{footer}</span>
          {canReask && <button type="button" disabled={busy} onClick={() => decide('ask_again')} style={{ height: 28, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}>Ask again</button>}
          {canUndo && <button type="button" disabled={busy} onClick={() => decide('undo')} className="hv-sunk" style={{ height: 28, padding: '0 10px', border: 0, borderRadius: 7, background: 'transparent', color: 'var(--accInk)', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}>Undo</button>}
        </div>
      )}
    </div>
  );
}

/* ---------------- structure proposal (pending) */
function StructurePending({ card, busy, decide }: { card: Card; busy: boolean; decide: (a: string, d?: Record<string, unknown>) => void }) {
  const { files } = useChat();
  const p = card.payload || {};
  const tplLang = String(p.language || '').toUpperCase();
  const [lang, setLang] = useState(tplLang);
  const [picking, setPicking] = useState(false);
  const [changing, setChanging] = useState(false);
  const [instructions, setInstructions] = useState('');
  const sheets: { name: string; sections?: any[] }[] = Array.isArray(p.sheets) ? p.sheets : [];
  const sections = sheets.flatMap((sh) => (sh.sections || []).map((x: any) => (typeof x === 'string' ? x : x.title))).filter(Boolean);
  const items = Number(p.item_count ?? sheets.reduce((a, sh) => a + (sh.sections || []).reduce((b: number, x: any) => b + (x.items?.length || 0), 0), 0));
  const columns = (Array.isArray(p.columns) ? p.columns : []).map((c: any) => (typeof c === 'string' ? c : c.header || c.name)).filter(Boolean);
  const logic = (Array.isArray(p.pricing_logic) ? p.pricing_logic : []).map((l: any) => (typeof l === 'string' ? l : JSON.stringify(l)));
  const alts: { file_id: string; name: string; score?: number }[] = Array.isArray(p.alternatives) ? p.alternatives : [];
  const langs = useMemo(() => (LANGS.some((l) => l[0] === tplLang) || !tplLang ? LANGS : [[tplLang, tplLang] as [string, string], ...LANGS]), [tplLang]);
  const cell: React.CSSProperties = { padding: '9px 0', borderBottom: '1px solid var(--line2)' };
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '96px minmax(0,1fr)', margin: '0 16px', borderTop: '1px solid var(--line2)', fontSize: 13 }}>
        <div style={{ ...cell, color: 'var(--ink3)' }}>Sheets</div><div style={cell}>{sheets.map((x) => x.name).join(' · ') || '—'}</div>
        <div style={{ ...cell, color: 'var(--ink3)' }}>Sections</div>
        <div style={cell}>{sections.join(' · ') || '—'}{items ? <span style={{ color: 'var(--ink3)' }}> · {items} item{items === 1 ? '' : 's'}</span> : null}</div>
        <div style={{ ...cell, color: 'var(--ink3)' }}>Columns</div><div style={cell}>{columns.join(' · ') || '—'}</div>
        <div style={{ ...cell, color: 'var(--ink3)' }}>Pricing</div><div style={cell}>{logic.slice(0, 3).join(' ') || 'From the template’s references and hourly norms.'}</div>
        <div style={{ padding: '9px 0', color: 'var(--ink3)', display: 'flex', alignItems: 'center' }}>Language</div>
        <div style={{ padding: '6px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language"
            style={{ height: 30, padding: '0 8px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 13 }}>
            {langs.map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
          </select>
          <span style={{ fontSize: 12, color: 'var(--ink3)' }}>{!tplLang || lang === tplLang ? 'Same as the template' : `Changed from ${tplLang}`}</span>
        </div>
      </div>
      {picking && (
        <div style={{ margin: '10px 16px 0', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
          {alts.length === 0 && <div style={{ padding: '9px 12px', fontSize: 13, color: 'var(--ink3)' }}>No other analysed reference estimate is available in this chat.</div>}
          {alts.map((o) => (
            <button key={o.file_id} type="button" disabled={busy} onClick={() => decide('use_reference', { file_id: o.file_id })} className="hv-sunk"
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', border: 0, borderBottom: '1px solid var(--line2)', background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer' }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</span>
              {o.score != null && <span style={{ fontSize: 12, color: 'var(--ink3)' }}>{Math.round(Math.min(1, o.score) * 100)}% match</span>}
              {files[o.file_id]?.language && <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, color: 'var(--ink2)', border: '1px solid var(--line)', borderRadius: 4, padding: '0 5px' }}>{files[o.file_id].language}</span>}
            </button>
          ))}
        </div>
      )}
      {changing && (
        <div style={{ display: 'flex', gap: 8, margin: '10px 16px 0', flexWrap: 'wrap' }}>
          <input autoFocus value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="What should change? E.g. split cables by floor"
            onKeyDown={(e) => { if (e.key === 'Enter' && instructions.trim()) decide('change', { instructions }); }}
            style={{ flex: 1, minWidth: 200, height: 36, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 13.5, outlineColor: 'var(--acc)' }} />
          <button type="button" disabled={busy || !instructions.trim()} onClick={() => decide('change', { instructions })} style={{ ...btnSecondary, opacity: instructions.trim() ? 1 : 0.6 }}>Send</button>
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '14px 16px 16px' }}>
        <button type="button" disabled={busy} onClick={() => decide('generate', lang && lang !== tplLang ? { language: lang } : undefined)} className="hv-accbg" style={btnPrimary}>Generate</button>
        <button type="button" disabled={busy} onClick={() => { setChanging(!changing); setPicking(false); }} className="hv-sunk" style={{ ...btnSecondary, fontWeight: 400 }}>Change structure</button>
        <button type="button" disabled={busy} onClick={() => { setPicking(!picking); setChanging(false); }} className="hv-sunk" style={{ ...btnSecondary, fontWeight: 400 }}>Use a different reference</button>
      </div>
    </>
  );
}

/* ---------------- clarifying questions */
const SKIP = 'No preference, use your defaults';
function ClarifyBody({ card, busy, decide }: { card: Card; busy: boolean; decide: (a: string, d?: Record<string, unknown>) => void }) {
  const p = card.payload || {};
  const qs: {
    id: string; text: string; options?: (string | { value?: string; label?: string })[]; multi?: boolean; suggested?: string[];
    type?: 'number' | 'date' | 'text'; default?: number | string | null; unit?: string; hint?: string; optional?: boolean;
    option_meta?: Record<string, { confidence?: number; reason?: string }>;
  }[] = Array.isArray(p.questions) ? p.questions : [];
  const [ans, setAns] = useState<Record<string, unknown>>(() => Object.fromEntries([
    ...qs.filter((q) => q.multi && q.suggested?.length).map((q) => [q.id, q.suggested]),
    ...qs.filter((q) => q.type === 'number' && q.default != null).map((q) => [q.id, String(q.default)]),
    ...qs.filter((q) => (q.type === 'date' || q.type === 'text' || (q.options?.length && !q.multi)) && q.default != null)
      .map((q) => [q.id, String(q.default)]),
  ]));
  const validNumber = (v: unknown) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) && n > 0; };
  const answered = qs.filter((q) => { const v = ans[q.id]; if (q.optional && (v == null || v === '')) return true; if (q.type === 'number') return validNumber(v); return Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null; }).length;
  const all = answered === qs.length;

  if (card.status !== 'pending') {
    const given = (card.decision?.data?.answers ?? {}) as Record<string, unknown>;
    const list = qs.flatMap((q) => {
      const v = given[q.id];
      if (v == null || v === '') return [];
      return (Array.isArray(v) ? v : [v]).map((x) => (q.type === 'number' && q.unit ? `${x} ${q.unit}` : String(x)));
    });
    if (!list.length) return null;
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 16px 12px' }}>
        {list.map((a, i) => <span key={i} style={{ height: 26, display: 'inline-flex', alignItems: 'center', padding: '0 10px', borderRadius: 13, background: 'var(--sunk)', fontSize: 12.5, color: 'var(--ink2)' }}>{a}</span>)}
      </div>
    );
  }
  const skip = () => decide('answer', { answers: Object.fromEntries(qs.map((q) => [q.id, ans[q.id] ?? (q.type === 'number' ? q.default ?? null : q.multi && q.suggested?.length ? q.suggested : SKIP)])) });
  const send = () => decide('answer', { answers: Object.fromEntries(qs.map((q) => [q.id, q.type === 'number' ? (ans[q.id] == null || ans[q.id] === '' ? null : Number(String(ans[q.id]).replace(',', '.'))) : ans[q.id]])) });
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '10px 16px 4px' }}>
        {qs.map((q, i) => {
          const opts = (q.options || []).map((o) => (typeof o === 'string' ? { v: o, l: o } : { v: String(o.value ?? o.label), l: String(o.label ?? o.value) }));
          const cur = ans[q.id];
          return (
            <div key={q.id} style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>{i + 1}. {q.text}</div>
              {opts.length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role={q.multi ? 'group' : 'radiogroup'} aria-label={q.text}>
                  {opts.map((o) => {
                    const on = q.multi ? Array.isArray(cur) && cur.includes(o.v) : cur === o.v;
                    const meta = q.option_meta?.[o.v];
                    return (
                      <button key={o.v} type="button" role={q.multi ? 'checkbox' : 'radio'} aria-checked={on} title={meta?.reason}
                        onClick={() => setAns((a) => {
                          if (!q.multi) return { ...a, [q.id]: o.v };
                          const set = new Set(Array.isArray(a[q.id]) ? (a[q.id] as string[]) : []);
                          if (set.has(o.v)) set.delete(o.v); else set.add(o.v);
                          return { ...a, [q.id]: [...set] };
                        })}
                        style={{ height: 30, padding: '0 12px', borderRadius: 15, border: `1px solid ${on ? 'var(--acc)' : 'var(--line)'}`, background: on ? 'var(--acc)' : 'var(--panel)', color: on ? '#fff' : 'var(--ink)', font: 'inherit', fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        {o.l}
                        {meta?.confidence != null && <span style={{ fontFamily: 'var(--mono)', fontSize: 11, opacity: 0.75 }}>{Math.round(meta.confidence * 100)}%</span>}
                      </button>
                    );
                  })}
                </div>
              ) : q.type === 'date' ? (
                <input type="date" value={String(cur ?? '')} onChange={(e) => setAns((a) => ({ ...a, [q.id]: e.target.value }))} aria-label={q.text}
                  style={{ width: 170, height: 34, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 13.5, outlineColor: 'var(--acc)' }} />
              ) : q.type === 'number' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <input inputMode="decimal" value={String(cur ?? '')} onChange={(e) => setAns((a) => ({ ...a, [q.id]: e.target.value }))} aria-label={q.text}
                      style={{ width: 110, height: 34, padding: '0 10px', border: `1px solid ${validNumber(cur) || (q.optional && (cur == null || cur === '')) ? 'var(--line)' : 'var(--err)'}`, borderRadius: 9, background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'var(--mono)', fontSize: 14, textAlign: 'right', outlineColor: 'var(--acc)' }} />
                    {q.unit && <span style={{ fontSize: 13, color: 'var(--ink2)' }}>{q.unit}</span>}
                  </label>
                  {q.hint && <span style={{ fontSize: 12.5, color: 'var(--ink3)' }}>{q.hint}</span>}
                </div>
              ) : (
                <input value={String(cur ?? '')} onChange={(e) => setAns((a) => ({ ...a, [q.id]: e.target.value }))} aria-label={q.text} placeholder="Your answer"
                  style={{ height: 34, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 13.5, maxWidth: 420, outlineColor: 'var(--acc)' }} />
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '14px 16px 16px' }}>
        <button type="button" disabled={busy || !all} onClick={send}
          style={{ ...btnPrimary, background: all ? 'var(--acc)' : 'var(--ink3)', cursor: all ? 'pointer' : 'default' }}>Send answers</button>
        <button type="button" disabled={busy} onClick={skip} className="hv-sunk"
          style={{ height: 36, padding: '0 12px', border: 0, borderRadius: 9, background: 'transparent', color: 'var(--ink2)', font: 'inherit', fontSize: 13.5, cursor: 'pointer' }}>Skip, use defaults</button>
        <span style={{ fontSize: 12, color: 'var(--ink3)' }}>{answered} of {qs.length} answered</span>
      </div>
    </>
  );
}
