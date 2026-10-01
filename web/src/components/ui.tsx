'use client';

/**
 * Small shared primitives from the design's component set (design/components.dc.html §Badges and tags,
 * design/DESIGN.md §5.7). Styling is inline with the design tokens, as in the design files.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

export const MONO = 'var(--mono)';

/* ---------- colour pairs ---------- */
export type Tone = 'ok' | 'acc' | 'warn' | 'err' | 'mute' | 'web';
export const TONE: Record<Tone, [string, string]> = {
  ok: ['var(--ok)', 'var(--okSoft)'],
  acc: ['var(--accInk)', 'var(--accSoft)'],
  warn: ['var(--warn)', 'var(--warnSoft)'],
  err: ['var(--err)', 'var(--errSoft)'],
  mute: ['var(--ink2)', 'var(--sunk)'],
  web: ['var(--web)', 'var(--webSoft)'],
};

/* ---------- status badge: dot + label, pill ---------- */
const STATUS_TONE: Record<string, Tone> = {
  queued: 'mute', reading: 'acc', analysing: 'acc', analysed: 'ok', failed: 'err',
  'in progress': 'acc', in_progress: 'acc', running: 'acc', waiting: 'warn', paused_cost: 'warn',
  done: 'ok', sent: 'mute', 'needs attention': 'warn', cancelled: 'mute',
};
export function statusTone(status: string): Tone {
  return STATUS_TONE[status.toLowerCase()] ?? 'mute';
}
export function StatusBadge({ label, tone, style }: { label: string; tone?: Tone; style?: CSSProperties }) {
  const [fg, bg] = TONE[tone ?? statusTone(label)];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 11, fontSize: 12, fontWeight: 500, color: fg, background: bg, whiteSpace: 'nowrap', ...style }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flex: 'none' }} />
      {label}
    </span>
  );
}

/* ---------- language tag (LV / EN / DA): the estimate's content language, never the UI language ---------- */
export function LangTag({ lang, style }: { lang?: string | null; style?: CSSProperties }) {
  if (!lang) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', height: 17, padding: '0 5px', border: '1px solid var(--line)', borderRadius: 4, fontFamily: MONO, fontSize: 10, fontWeight: 600, color: 'var(--ink2)', flex: 'none', ...style }}>
      {lang.toUpperCase().slice(0, 2)}
    </span>
  );
}

/* ---------- file kind ---------- */
export function kindOf(nameOrExt?: string | null): 'xlsx' | 'pdf' | 'docx' {
  const e = String(nameOrExt ?? '').toLowerCase().split('.').pop() ?? '';
  if (e === 'pdf') return 'pdf';
  if (e === 'docx' || e === 'doc') return 'docx';
  return 'xlsx';
}
export const KIND: Record<'xlsx' | 'pdf' | 'docx', [string, string, string]> = {
  xlsx: ['XLSX', 'var(--ok)', 'var(--okSoft)'],
  pdf: ['PDF', 'var(--err)', 'var(--errSoft)'],
  docx: ['DOCX', 'var(--accInk)', 'var(--accSoft)'],
};
/** Label shown for the file's real extension (XLS stays XLS), coloured by kind. */
export function kindLabel(nameOrExt?: string | null): string {
  const e = String(nameOrExt ?? '').toLowerCase().split('.').pop() ?? '';
  return ['xlsx', 'xls', 'pdf', 'docx', 'doc'].includes(e) ? e.toUpperCase() : KIND[kindOf(e)][0];
}
/** The file-type tile (28×32 in lists). */
export function KindIcon({ name, w = 28, h = 32, fontSize = 8 }: { name?: string | null; w?: number; h?: number; fontSize?: number }) {
  const [, fg, bg] = KIND[kindOf(name)];
  return (
    <span style={{ width: w, height: h, flex: 'none', borderRadius: 5, background: bg, color: fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize, fontWeight: 600 }}>
      {kindLabel(name)}
    </span>
  );
}
/** Inline kind label (e.g. inside a file chip). */
export function KindText({ name, style }: { name?: string | null; style?: CSSProperties }) {
  const [, fg] = KIND[kindOf(name)];
  return <span style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 600, color: fg, ...style }}>{kindLabel(name)}</span>;
}

/* ---------- tier + cost badge (message footer; hover shows tokens) ---------- */
export function TierCost({ tier, cost, tokensIn, tokensOut }: { tier?: string | null; cost?: number | null; tokensIn?: number | null; tokensOut?: number | null }) {
  const [hover, setHover] = useState(false);
  const name = tier ? tier[0].toUpperCase() + tier.slice(1) : 'Auto';
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink3)' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span style={{ display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 7px', borderRadius: 5, border: '1px solid var(--line)', fontWeight: 500, color: 'var(--ink2)' }}>{name}</span>
      <span style={{ fontFamily: MONO }}>{fmtUsd(cost ?? 0)}</span>
      {hover && (tokensIn != null || tokensOut != null) && (
        <span role="tooltip" style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 30, padding: '8px 10px', borderRadius: 8, background: 'var(--ink)', color: 'var(--bg)', fontFamily: MONO, fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'nowrap' }}>
          {fmtInt(tokensIn ?? 0)} input tokens<br />{fmtInt(tokensOut ?? 0)} output tokens
        </span>
      )}
    </span>
  );
}

/* ---------- spinner ---------- */
export function Spinner({ size = 14, color = 'var(--acc)' }: { size?: number; color?: string }) {
  return <span aria-hidden style={{ width: size, height: size, flex: 'none', borderRadius: '50%', border: `2px solid ${color}`, borderRightColor: 'transparent', display: 'inline-block', animation: 'spin .8s linear infinite' }} />;
}

/* ---------- buttons ---------- */
export const btn = {
  primary: { height: 38, padding: '0 16px', border: 0, borderRadius: 10, background: 'var(--acc)', color: '#fff', fontWeight: 600, fontSize: 13.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 } as CSSProperties,
  secondary: { height: 38, padding: '0 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)', color: 'var(--ink)', fontWeight: 500, fontSize: 13.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 } as CSSProperties,
  ghost: { height: 32, padding: '0 10px', border: 0, borderRadius: 8, background: 'transparent', color: 'var(--ink2)', fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 } as CSSProperties,
  danger: { height: 38, padding: '0 16px', border: 0, borderRadius: 10, background: 'var(--err)', color: '#fff', fontWeight: 600, fontSize: 13.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 } as CSSProperties,
};
export const input: CSSProperties = { height: 42, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)', color: 'var(--ink)', fontWeight: 400, fontSize: 14.5, outlineColor: 'var(--acc)', width: '100%' };
export const card: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, padding: 20, border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)' };

/* ---------- modal ---------- */
export function Modal({ open, onClose, children, width = 440, label }: { open: boolean; onClose: () => void; children: ReactNode; width?: number; label?: string }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div role="presentation" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(10,12,16,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: width, maxHeight: '90vh', overflow: 'auto', background: 'var(--panel)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 14, boxShadow: '0 20px 60px rgba(0,0,0,0.25)', padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {children}
      </div>
    </div>
  );
}

/* ---------- hooks ---------- */
/** Below 760px the design switches to its phone layout. */
export function useIsMobile(breakpoint = 760): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const f = () => setM(window.innerWidth < breakpoint);
    f();
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, [breakpoint]);
  return m;
}

/* ---------- formatting ---------- */
export function fmtUsd(n: unknown, digits = 2): string {
  const v = Number(n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(digits)}`;
}
export function fmtInt(n: unknown): string {
  const v = Number(n ?? 0);
  return (Number.isFinite(v) ? v : 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
/** Money in the estimate's currency, e.g. "DKK 17,480". */
export function fmtMoney(n: unknown, currency?: string | null, digits = 0): string {
  const v = Number(n ?? 0);
  const s = (Number.isFinite(v) ? v : 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return currency ? `${currency} ${s}` : s;
}
export function fmtBytes(n: unknown): string {
  const v = Number(n ?? 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}
/** "today 10:45", "yesterday 09:12", "28 Sep 2026". */
export function fmtWhen(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const now = new Date();
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `today ${hm}`;
  if (diff === 1) return `yesterday ${hm}`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function fmtDate(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function initials(name?: string | null, email?: string | null): string {
  const src = (name || email || '?').trim();
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}
