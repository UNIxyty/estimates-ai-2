'use client';

/**
 * Frame around a page and its document viewer (see ViewerLayout.tsx for the contract; design: chat.dc.html
 * split / full / phone). The page's children always stay mounted in the same place, so opening, resizing or
 * closing the viewer never resets the page (chat scroll, composer draft).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShell } from '../Shell';
import type { ViewerLayoutProps } from './ViewerLayout';
import type { DocRef } from './types';
import { DocViewer } from './DocViewer';
import s from './Viewer.module.css';
import { BrandLogo } from '@/components/Brand';

const MIN = 0.26, MAX = 0.7;

export function ViewerLayout({ viewer, children, onAsk, renderAsk, railLabel = 'Chat' }: ViewerLayoutProps) {
  const { mobile, setCollapsedOverride } = useShell();
  const open = viewer.isOpen;
  const full = open && !mobile && viewer.mode === 'full';
  const split = open && !mobile && viewer.mode === 'split';
  const [frac, setFrac] = useState(0.56); // viewer share of the width in split view
  const [drag, setDrag] = useState(false);
  const [float, setFloat] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);

  // The app sidebar collapses to its rail while a document is open beside the page.
  useEffect(() => {
    if (!open || mobile) return;
    setCollapsedOverride(true);
    return () => setCollapsedOverride(null);
  }, [open, mobile, setCollapsedOverride]);

  useEffect(() => { if (!full) setFloat(false); }, [full]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(true);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || !rowRef.current) return;
    const r = rowRef.current.getBoundingClientRect();
    setFrac(Math.min(MAX, Math.max(MIN, 1 - (e.clientX - r.left) / r.width)));
  }, [drag]);
  const endDrag = useCallback(() => setDrag(false), []);
  const onKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') setFrac((f) => Math.min(MAX, f + 0.02));
    if (e.key === 'ArrowRight') setFrac((f) => Math.max(MIN, f - 0.02));
  }, []);

  const ask = useCallback((doc: DocRef) => {
    if (mobile) viewer.close();
    else if (viewer.mode === 'full' && renderAsk) setFloat(true);
    onAsk?.(doc);
  }, [mobile, viewer, renderAsk, onAsk]);

  const viewerEl = open ? (
    <DocViewer viewer={viewer} mode={mobile ? 'sheet' : viewer.mode} onAsk={onAsk ? ask : undefined} backLabel={`Back to ${railLabel.toLowerCase()}`} />
  ) : null;

  return (
    <div ref={rowRef} style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', position: 'relative', userSelect: drag ? 'none' : undefined }}>
      <div style={{ width: split ? `${(1 - frac) * 100}%` : undefined, flex: split ? 'none' : 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </div>

      {split && (
        <div key="divider" role="separator" aria-orientation="vertical" aria-label="Resize document viewer" aria-valuemin={MIN * 100} aria-valuemax={MAX * 100} aria-valuenow={Math.round(frac * 100)}
          tabIndex={0} title="Drag to resize" className={s.divider}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={onKey}
          style={{ width: 9, flex: 'none', margin: '0 -4px', zIndex: 5, cursor: 'col-resize', display: 'flex', justifyContent: 'center', touchAction: 'none' }}>
          <div style={{ width: 1, height: '100%', background: drag ? 'var(--acc)' : 'var(--line)' }} />
        </div>
      )}

      {full && (
        <div key="rail" style={{ position: 'fixed', left: 0, top: 0, bottom: 0, width: 64, zIndex: 45, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '12px 0', borderRight: '1px solid var(--line)', background: 'var(--side)' }}>
          <BrandLogo size={16} style={{ padding: '6px 0' }} />
          <button type="button" onClick={() => viewer.setMode('split')} title="Back to split view" className={s.ghost}
            style={{ width: 48, padding: '8px 0', border: 0, borderRadius: 10, background: 'transparent', color: 'var(--ink2)', font: 'inherit', fontSize: 11, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            <span style={{ fontSize: 15 }}>‹</span>{railLabel}
          </button>
          {renderAsk && (
            <button type="button" onClick={() => setFloat((f) => !f)} title="Ask the agent" aria-pressed={float}
              style={{ width: 48, padding: '8px 0', border: 0, borderRadius: 10, background: float ? 'var(--accSoft)' : 'transparent', color: float ? 'var(--accInk)' : 'var(--ink2)', font: 'inherit', fontSize: 11, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <span style={{ fontSize: 15 }}>↑</span>Ask
            </button>
          )}
        </div>
      )}

      {open && (
        // One container for every mode, so switching split <-> full keeps the viewer (sheet, scroll, find) as it is.
        <div key="viewer" role={mobile ? 'dialog' : undefined} aria-modal={mobile ? true : undefined} aria-label="Document viewer"
          style={mobile
            ? { position: 'fixed', inset: 0, zIndex: 50, display: 'flex', background: 'var(--panel)' }
            : full
              ? { position: 'fixed', top: 0, bottom: 0, left: 64, right: 0, zIndex: 45, display: 'flex', background: 'var(--panel)' }
              : { flex: 1, minWidth: 0, display: 'flex', position: 'relative', pointerEvents: drag ? 'none' : undefined }}>
          {viewerEl}
          {full && float && renderAsk && (
            <div style={{ position: 'absolute', left: 24, bottom: 24, width: 'min(640px, calc(100% - 48px))', zIndex: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ boxShadow: '0 12px 40px rgba(16,24,40,0.18)', borderRadius: 18 }}>{renderAsk()}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
