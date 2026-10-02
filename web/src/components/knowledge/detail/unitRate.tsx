'use client';

/** Shared bits of the unit-rate BOQ views (Structure, Rate card, Saved numbers): money, basis chips, note rows. */
import type { CSSProperties, ReactNode } from 'react';
import { TONE, type Tone } from '@/components/ui';

/** "€1,234.5", "€0.75"; null → "—". */
export function eur(v: unknown, digits = 2): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return '—';
  return `€${n.toLocaleString('en-GB', { maximumFractionDigits: digits })}`;
}

/** "12", "5.46", "0.3642" (ratios keep 4 decimals). */
export function num(v: unknown, digits = 2): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (v == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-GB', { maximumFractionDigits: digits });
}

/** "2025-05-25" → "25 May 2025". */
export function longDate(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const LINE_PACKAGE: Record<string, string> = {
  containment: 'Containment', lighting: 'Lighting', gs_sp: 'GS / small power', cable: 'Cable', electrical: 'Electrical',
  prelims: 'Preliminaries', contractor_items: 'Contractor items',
};

const isFreeIssue = (title?: string | null) => !!title && /free\s*-?\s*issue/i.test(title);

/** Plain label of a pricing basis; install-only rows in a free-issued section read "Free issue — install only". */
export function basisLabel(basis: string | null | undefined, sectionTitle?: string | null): string | null {
  switch (basis) {
    case 'install_only': return isFreeIssue(sectionTitle) ? 'Free issue — install only' : 'Install only';
    case 'supply_and_install': return 'Supply & install';
    case 'supply_only': return 'Supply only';
    case 'lump_sum': return 'Lump sum';
    case 'weekly': return 'Per week';
    case 'monthly': return 'Per month';
    case 'percent': return 'Percent';
    default: return null;
  }
}
const BASIS_TONE: Record<string, Tone> = { install_only: 'acc', supply_and_install: 'ok', supply_only: 'web' };

export function Chip({ tone = 'mute', children, title, style }: { tone?: Tone; children: ReactNode; title?: string; style?: CSSProperties }) {
  const [fg, bg] = TONE[tone];
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 8px', borderRadius: 11, background: bg, color: fg, fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', flex: 'none', ...style }}>
      {children}
    </span>
  );
}

export function BasisChip({ basis, sectionTitle }: { basis: string | null | undefined; sectionTitle?: string | null }) {
  const label = basisLabel(basis, sectionTitle);
  if (!label) return null;
  return <Chip tone={BASIS_TONE[basis ?? ''] ?? 'mute'}>{label}</Chip>;
}

/** Plain-language names of the review flags the worker sets on rows whose rate is not learned. */
export const FLAG_LABEL: Record<string, string> = {
  CONFLICTING_DESCRIPTION: 'Conflicting description',
};
export const flagLabel = (f: string) => FLAG_LABEL[f] ?? f.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function FlagChip({ flag }: { flag: string }) {
  return <Chip tone="warn" title={flag === 'CONFLICTING_DESCRIPTION' ? 'The row describes two different products (e.g. 5-core and 3G); its rate is not learned' : flag}>⚠ {flagLabel(flag)}</Chip>;
}

/** Yellow note row: text in the BOQ that changes what a rate means. */
export function NoteRow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '9px 16px', background: 'var(--hl2)', borderBottom: '1px solid var(--line2)', fontSize: 13, lineHeight: 1.5, color: 'var(--ink)', ...style }}>
      <span aria-hidden style={{ flex: 'none', fontSize: 11, fontWeight: 700, color: 'var(--warn)', paddingTop: 2, letterSpacing: '0.02em' }}>NOTE</span>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

export const panel: CSSProperties = { border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', overflow: 'hidden' };
export const sectionTitle: CSSProperties = { fontSize: 15, fontWeight: 600 };
export const muted: CSSProperties = { fontSize: 13.5, color: 'var(--ink2)', lineHeight: 1.5 };
export const th: CSSProperties = { padding: '10px 8px', fontSize: 12, fontWeight: 600, color: 'var(--ink2)' };
export const monoNum: CSSProperties = { fontFamily: 'var(--mono)', fontSize: 12.5, fontVariantNumeric: 'tabular-nums', textAlign: 'right', whiteSpace: 'nowrap' };
