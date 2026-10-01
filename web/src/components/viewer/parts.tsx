'use client';

/** Shared bits of the viewer: loading and failed states, toolbar controls (design/DocViewer.dc.html). */
import type { CSSProperties, ReactNode } from 'react';
import { ApiError } from '@/lib/client';
import { MONO } from '../ui';
import { failReason } from './viewerApi';
import s from './Viewer.module.css';

export function Loading() {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, padding: 24 }} aria-busy="true">
      <div style={{ fontSize: 12.5, color: 'var(--ink3)' }}>Opening document…</div>
      <div className={s.skel} style={{ height: 12, borderRadius: 4, width: '80%' }} />
      <div className={s.skel} style={{ height: 12, borderRadius: 4, width: '64%' }} />
      <div className={s.skel} style={{ height: 12, borderRadius: 4, width: '72%' }} />
    </div>
  );
}

export function Broken({ reason, onRetry, download }: { reason: string; onRetry?: () => void; download?: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, background: 'var(--sunk)', minHeight: 0 }}>
      <div role="alert" style={{ maxWidth: 380, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
        <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--errSoft)', color: 'var(--err)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 18 }}>!</div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>This document can&apos;t be displayed</div>
        <div style={{ color: 'var(--ink2)' }}>{reason}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          {onRetry && (
            <button type="button" onClick={onRetry} style={{ height: 34, padding: '0 14px', border: 0, borderRadius: 8, background: 'var(--acc)', color: '#fff', font: 'inherit', fontWeight: 600, cursor: 'pointer' }}>Try again</button>
          )}
          {download && (
            <a href={download} download style={{ height: 34, display: 'inline-flex', alignItems: 'center', padding: '0 14px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--ink)', textDecoration: 'none' }}>Download original</a>
          )}
        </div>
      </div>
    </div>
  );
}

export function errReason(e: unknown): string {
  if (e instanceof ApiError) return failReason(String(e.body?.error ?? ''), e.body?.reason ? String(e.body.reason) : undefined, e.status);
  return 'The document could not be loaded.';
}

export const toolbar: CSSProperties = { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--line2)', flexWrap: 'wrap' };

/** Phone: one row that scrolls sideways instead of wrapping (mobile.dc.html). */
export const toolbarPhone: CSSProperties = { ...toolbar, flexWrap: 'nowrap', overflowX: 'auto' };

export function SearchBox({ label, value, onChange, onKeyDown, placeholder, count, children, style }: {
  label: string; value: string; onChange: (v: string) => void; onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder: string; count: string; children?: ReactNode; style?: CSSProperties;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: children ? '0 4px 0 10px' : '0 10px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--bg)', flex: 1, minWidth: 160, maxWidth: 320, flexShrink: 0, ...style }}>
      <span style={{ color: 'var(--ink3)', fontSize: 12 }}>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} aria-label={label}
        style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--ink)', font: 'inherit', fontSize: 12.5 }} />
      <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--ink3)', whiteSpace: 'nowrap' }}>{count}</span>
      {children}
    </div>
  );
}

export const ZOOMS = [0.8, 0.9, 1, 1.15, 1.3];

export function Zoom({ zi, setZi }: { zi: number; setZi: (f: (z: number) => number) => void }) {
  const b: CSSProperties = { width: 28, height: 28, border: 0, background: 'transparent', color: 'var(--ink2)', fontSize: 15, cursor: 'pointer' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 30, border: '1px solid var(--line)', borderRadius: 7, overflow: 'hidden' }}>
      <button type="button" className={s.ghost} style={b} aria-label="Zoom out" disabled={zi <= 0} onClick={() => setZi((z) => Math.max(0, z - 1))}>−</button>
      <span style={{ minWidth: 44, textAlign: 'center', fontFamily: MONO, fontSize: 11.5, color: 'var(--ink2)' }}>{Math.round(ZOOMS[zi] * 100)}%</span>
      <button type="button" className={s.ghost} style={b} aria-label="Zoom in" disabled={zi >= ZOOMS.length - 1} onClick={() => setZi((z) => Math.min(ZOOMS.length - 1, z + 1))}>+</button>
    </div>
  );
}
