'use client';

/**
 * PDF view (design/DocViewer.dc.html, pdf branch) rendered with pdf.js: page thumbnails, Prev / Next with
 * "Page N of M", zoom and text search with highlights. The original bytes come from …/view/raw.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MONO } from '../ui';
import { Broken, Loading, SearchBox, ZOOMS, Zoom, toolbar, toolbarPhone } from './parts';
import st from './Viewer.module.css';
import { loadPdfjs, type PdfDoc, type PdfPage } from './pdfjs';

interface TextItem { str: string; transform: number[]; width: number; height: number }

export function PdfView({ src, download, isSheet }: { src: string; download: string; isSheet: boolean }) {
  const [pdf, setPdf] = useState<PdfDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [zi, setZi] = useState(2);
  const [q, setQ] = useState('');
  const [texts, setTexts] = useState<TextItem[][] | null>(null);
  const [cw, setCw] = useState(600);
  const areaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let off = false;
    let doc: PdfDoc | null = null;
    setPdf(null); setErr(null); setPage(1); setTexts(null);
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const task = pdfjs.getDocument({ url: src, withCredentials: true });
        doc = await task.promise;
        if (off) { void doc.destroy(); return; }
        setPdf(doc);
      } catch (e) {
        if (off) return;
        const name = (e as { name?: string })?.name;
        setErr(name === 'PasswordException'
          ? "The PDF is password-protected, so the viewer can't read its pages."
          : name === 'InvalidPDFException' ? 'The file is not a valid PDF. It may be damaged.'
          : name === 'ResponseException' || name === 'MissingPDFException' ? 'The file could not be loaded. It may have been deleted.'
          : `The PDF could not be opened${(e as Error)?.message ? ` (${(e as Error).message})` : ''}.`);
      }
    })();
    return () => { off = true; if (doc) void doc.destroy(); };
  }, [src, attempt]);

  const setArea = useCallback((el: HTMLDivElement | null) => {
    areaRef.current = el;
    if (!el) return;
    const ro = new ResizeObserver(() => setCw(el.clientWidth));
    ro.observe(el);
    setCw(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Text of every page, extracted once when the user first searches.
  useEffect(() => {
    if (!pdf || !q.trim() || texts) return;
    let off = false;
    (async () => {
      const all: TextItem[][] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const pg = await pdf.getPage(i);
        const tc = await pg.getTextContent();
        all.push((tc.items as unknown[]).filter((x): x is TextItem => typeof (x as TextItem).str === 'string'));
        if (off) return;
      }
      setTexts(all);
    })().catch(() => {});
    return () => { off = true; };
  }, [pdf, q, texts]);

  const needle = q.trim().toLowerCase();
  const counts = texts && needle ? texts.map((items) => items.reduce((a, it) => a + countIn(it.str.toLowerCase(), needle), 0)) : null;
  const hits = counts ? counts.reduce((a, b) => a + b, 0) : 0;
  const nextHit = (dir: 1 | -1) => {
    if (!counts || !hits) return;
    for (let k = 1; k <= counts.length; k++) {
      const p = ((page - 1 + dir * k) % counts.length + counts.length) % counts.length;
      if (counts[p]) { setPage(p + 1); return; }
    }
  };
  // Jump to the first page with a match when a search finishes.
  useEffect(() => {
    if (!counts || !hits || counts[page - 1]) return;
    const p = counts.findIndex((c) => c > 0);
    if (p >= 0) setPage(p + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texts, needle]);

  if (err) return <Broken reason={err} onRetry={() => setAttempt((a) => a + 1)} download={download} />;
  if (!pdf) return <Loading />;

  const total = pdf.numPages;
  const pageW = Math.round(Math.min(Math.max(cw - 32, 240), isSheet ? 520 : 820) * ZOOMS[zi]);
  const navBtn = { height: 30, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel)', color: 'var(--ink2)', font: 'inherit', fontSize: 12, cursor: 'pointer' } as const;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={isSheet ? toolbarPhone : toolbar} className={isSheet ? st.noScrollbar : undefined}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button type="button" style={{ ...navBtn, opacity: page > 1 ? 1 : 0.5 }} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹ Prev</button>
          <span style={{ minWidth: 92, textAlign: 'center', fontSize: 12, color: 'var(--ink2)' }}>Page {page} of {total}</span>
          <button type="button" style={{ ...navBtn, opacity: page < total ? 1 : 0.5 }} disabled={page >= total} onClick={() => setPage((p) => Math.min(total, p + 1))}>Next ›</button>
        </div>
        <SearchBox label="Search" value={q} onChange={setQ} placeholder="Text in document" style={{ maxWidth: 300 }}
          count={needle ? (counts ? (hits ? `${hits} match${hits === 1 ? '' : 'es'}` : 'No matches') : '…') : ''}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); nextHit(e.shiftKey ? -1 : 1); } }} />
        <Zoom zi={zi} setZi={setZi} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {!isSheet && (
          <div style={{ width: 104, flex: 'none', overflow: 'auto', borderRight: '1px solid var(--line)', background: 'var(--side)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '14px 0' }}>
            {Array.from({ length: total }, (_, i) => (
              <Thumb key={i} pdf={pdf} n={i + 1} on={page === i + 1} hit={!!counts?.[i]} onClick={() => setPage(i + 1)} />
            ))}
          </div>
        )}
        <div ref={setArea} style={{ flex: 1, minWidth: 0, overflow: 'auto', background: 'var(--sunk)', padding: '24px 16px' }}>
          <PageCanvas pdf={pdf} n={page} width={pageW} items={texts?.[page - 1]} needle={needle} />
        </div>
      </div>
    </div>
  );
}

let measureCtx: CanvasRenderingContext2D | null = null;
/** Relative text width (a sans-serif stand-in for the PDF font) to place highlights inside a text run. */
function measure(t: string): number {
  if (!measureCtx) { measureCtx = document.createElement('canvas').getContext('2d'); if (measureCtx) measureCtx.font = '100px Helvetica, Arial, sans-serif'; }
  return measureCtx ? measureCtx.measureText(t).width : t.length;
}

function countIn(h: string, n: string): number {
  if (!n) return 0;
  let c = 0, i = h.indexOf(n);
  while (i >= 0) { c++; i = h.indexOf(n, i + n.length); }
  return c;
}

function PageCanvas({ pdf, n, width, items, needle }: { pdf: PdfDoc; n: number; width: number; items?: TextItem[]; needle: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pg, setPg] = useState<PdfPage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let off = false;
    setFailed(false);
    pdf.getPage(n).then((p) => { if (!off) setPg(p); }).catch(() => { if (!off) setFailed(true); });
    return () => { off = true; };
  }, [pdf, n]);

  const base = pg?.getViewport({ scale: 1 });
  const scale = base ? width / base.width : 1;
  const vp = pg?.getViewport({ scale });

  useEffect(() => {
    const c = canvasRef.current;
    if (!pg || !vp || !c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.floor(vp.width * dpr);
    c.height = Math.floor(vp.height * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const task = pg.render({ canvasContext: ctx, canvas: c, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
    task.promise.catch(() => {});
    return () => task.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pg, width]);

  if (failed) return <div style={{ color: 'var(--ink3)', fontSize: 13, textAlign: 'center' }}>Page {n} could not be drawn.</div>;
  const h = vp ? vp.height : width * 1.414;
  const marks: { x: number; y: number; w: number; h: number }[] = [];
  if (vp && items && needle) {
    for (const it of items) {
      const low = it.str.toLowerCase();
      let i = low.indexOf(needle);
      if (i < 0) continue;
      const [a, b, , , e, f] = it.transform;
      const fh = Math.hypot(a, b) || it.height || 10;
      const [x0, y0] = vp.convertToViewportPoint(e, f) as number[];
      const [x1, y1] = vp.convertToViewportPoint(e + it.width, f + fh) as number[];
      const left = Math.min(x0, x1), wTot = Math.abs(x1 - x0), top = Math.min(y0, y1), hh = Math.abs(y1 - y0);
      const full = measure(it.str) || 1;
      while (i >= 0) {
        const x0r = measure(it.str.slice(0, i)) / full, x1r = measure(it.str.slice(0, i + needle.length)) / full;
        marks.push({ x: left + wTot * x0r, y: top - hh * 0.15, w: Math.max(2, wTot * (x1r - x0r)), h: hh * 1.3 });
        i = low.indexOf(needle, i + needle.length);
      }
    }
  }
  return (
    <div style={{ width, height: h, margin: '0 auto', position: 'relative', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.12),0 8px 24px rgba(0,0,0,0.08)' }}>
      <canvas ref={canvasRef} style={{ width, height: h, display: 'block' }} aria-label={`Page ${n}`} />
      {marks.map((m, i) => (
        <span key={i} style={{ position: 'absolute', left: m.x, top: m.y, width: m.w, height: m.h, background: '#ffe98a', mixBlendMode: 'multiply', opacity: 0.9, borderRadius: 2, pointerEvents: 'none' }} />
      ))}
    </div>
  );
}

function Thumb({ pdf, n, on, hit, onClick }: { pdf: PdfDoc; n: number; on: boolean; hit: boolean; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [ratio, setRatio] = useState(1.3);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setVisible(true); }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let off = false;
    let cancel: (() => void) | null = null;
    pdf.getPage(n).then((pg) => {
      const c = ref.current;
      if (off || !c) return;
      const base = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: 120 / base.width });
      setRatio(base.height / base.width);
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const t = pg.render({ canvasContext: ctx, canvas: c, viewport: vp });
      cancel = () => t.cancel();
      t.promise.catch(() => {});
    }).catch(() => {});
    return () => { off = true; cancel?.(); };
  }, [visible, pdf, n]);

  return (
    <button type="button" onClick={onClick} aria-label={`Page ${n}`} aria-current={on ? 'page' : undefined}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, border: 0, background: 'transparent', cursor: 'pointer', padding: 0, flex: 'none' }}>
      <canvas ref={ref} style={{ width: 60, height: Math.round(60 * ratio), background: '#fff', borderRadius: 2, boxShadow: `0 0 0 ${on ? '2px' : '0px'} var(--acc),0 1px 3px rgba(0,0,0,0.15)` }} />
      <span style={{ fontFamily: MONO, fontSize: 10.5, color: on ? 'var(--accInk)' : 'var(--ink3)', fontWeight: hit ? 600 : 400 }}>{n}{hit ? ' •' : ''}</span>
    </button>
  );
}
