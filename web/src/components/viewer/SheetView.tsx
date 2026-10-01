'use client';

/**
 * Spreadsheet view (design/DocViewer.dc.html, xlsx branch): the sheet's own columns in the source language,
 * sticky column header, frozen first columns, section / subtotal rows, a sticky subtotal of the section in
 * view, virtualised rows fetched in pages from the rows endpoint, Find / Go to row / zoom, jump to a row, and —
 * for agent-generated estimates — "Show only" filters, row markers and the row inspector.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '@/lib/client';
import { MONO, fmtInt } from '../ui';
import type { DocRef, Jump } from './types';
import {
  endpoints, type Cell, type Marker, type RowFilter, type RowsResponse, type SheetMeta, type SheetRow, type SheetsResponse,
} from './viewerApi';
import { Broken, Loading, SearchBox, ZOOMS, Zoom, errReason, toolbar, toolbarPhone } from './parts';
import { RowInspector } from './RowInspector';
import s from './Viewer.module.css';

const PAGE = 200;
const TAG: Record<Marker, [string, string]> = {
  WEB: ['var(--web)', 'var(--webSoft)'],
  CHECK: ['var(--warn)', 'var(--warnSoft)'],
  'NO PRICE': ['var(--err)', 'var(--errSoft)'],
  EDITED: ['var(--accInk)', 'var(--accSoft)'],
};
const MARK: Record<Marker, string> = { WEB: 'var(--web)', CHECK: 'var(--warn)', 'NO PRICE': 'var(--err)', EDITED: 'var(--acc)' };
const FILTERS: [Exclude<RowFilter, 'all'>, string, string][] = [
  ['attention', 'Needs attention', 'var(--warn)'],
  ['web', 'Web-sourced', 'var(--web)'],
  ['edited', 'Manually changed', 'var(--acc)'],
];

interface List { total: number | null; pages: Map<number, SheetRow[]>; inflight: Set<number> }

export interface SheetViewProps {
  doc: DocRef;
  lang?: string | null;
  isEstimate: boolean;
  isSheet: boolean;
  jump: Jump | null;
  jumpSeq: number;
  total?: { label: string; value: string } | null;
  currency?: string | null;
  onOpenDoc: (d: DocRef, j?: Jump) => void;
  onEdited?: (document: Record<string, unknown>) => void;
}

const colName = (c: number) => {
  let n = c, out = '';
  while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); }
  return out;
};
const findHint = (lang?: string | null) => {
  const l = (lang ?? '').toUpperCase();
  return `Item, e.g. ${l === 'DA' ? 'stikkontakt' : l === 'LV' ? 'kabelis' : l === 'EN' ? 'socket' : 'cable'}`;
};
const isNum = (v: unknown) => typeof v === 'number';
const flagLetters = (f: string) => f.split(';')[0];

export function SheetView({ doc, lang, isEstimate, isSheet, jump, jumpSeq, total, currency, onOpenDoc, onEdited }: SheetViewProps) {
  const ep = endpoints(doc);
  const [meta, setMeta] = useState<SheetsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [metaTick, setMetaTick] = useState(0);
  const [si, setSi] = useState<number | null>(null);
  const [zi, setZi] = useState(2);
  const [filter, setFilter] = useState<RowFilter>('all');
  const [find, setFind] = useState('');
  const [fres, setFres] = useState<{ matches: number[]; total: number } | null>(null);
  const [fi, setFi] = useState(0);
  const [gotoVal, setGotoVal] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const [hl, setHl] = useState<number | null>(null);
  const [st, setSt] = useState(0);
  const [vh, setVh] = useState(0);
  const [cw, setCw] = useState(800);
  const [reload, setReload] = useState(0);
  const [, setVer] = useState(0);
  const [rowsErr, setRowsErr] = useState<string | null>(null);
  const store = useRef(new Map<string, List>());
  const scRef = useRef<HTMLDivElement | null>(null);
  const pendingIdx = useRef<number | null>(null);
  const appliedSeq = useRef<number>(-1);

  /* ---------- workbook meta ---------- */
  useEffect(() => {
    let off = false;
    api<SheetsResponse>(ep.sheets)
      .then((m) => { if (!off) { setMeta(m); setErr(null); } })
      .catch((e) => { if (!off) setErr(errReason(e)); });
    return () => { off = true; };
  }, [ep.sheets, attempt, metaTick]);

  const visibleSheets = useMemo(() => (meta?.sheets ?? []).filter((x) => !x.state || x.state === 'visible'), [meta]);
  const sheetIdx = si ?? visibleSheets[0]?.idx ?? null;
  const sheet: SheetMeta | null = meta && sheetIdx != null ? meta.sheets[sheetIdx] ?? null : null;

  /* ---------- paged rows ---------- */
  const keyFor = (idx: number, f: RowFilter) => `${idx}|${f}|${reload}`;
  const list = useCallback((key: string): List => {
    let l = store.current.get(key);
    if (!l) { l = { total: null, pages: new Map(), inflight: new Set() }; store.current.set(key, l); }
    return l;
  }, []);
  const fetchPage = useCallback((idx: number, f: RowFilter, p: number, rl: number) => {
    const l = list(`${idx}|${f}|${rl}`);
    if (l.pages.has(p) || l.inflight.has(p)) return;
    l.inflight.add(p);
    const qs = new URLSearchParams({ sheet: String(idx), offset: String(p * PAGE), limit: String(PAGE) });
    if (f !== 'all') qs.set('filter', f);
    api<RowsResponse>(`${ep.rows}?${qs}`)
      .then((res) => { l.pages.set(p, res.rows); l.total = res.total; l.inflight.delete(p); setVer((v) => v + 1); })
      .catch((e) => { l.inflight.delete(p); setRowsErr(errReason(e)); });
  }, [ep.rows, list]);

  const cur = sheetIdx != null ? list(keyFor(sheetIdx, filter)) : null;
  const allList = sheetIdx != null ? list(keyFor(sheetIdx, 'all')) : null;
  const mc = sheet?.marker_counts;
  const filterCount = (f: RowFilter) => !mc ? 0 : f === 'attention' ? (mc.attention ?? mc.check + mc.no_price) : f === 'web' ? mc.web : f === 'edited' ? mc.edited : 0;
  const N = !sheet ? 0 : filter === 'all' ? sheet.row_count : (cur?.total ?? filterCount(filter));
  const rowAt = (i: number): SheetRow | undefined => cur?.pages.get(Math.floor(i / PAGE))?.[i % PAGE];

  /* ---------- geometry ---------- */
  const z = ZOOMS[zi];
  const rh = Math.round(30 * z);
  const fs = Math.round(12.5 * z * 10) / 10;

  const cols = useMemo(() => {
    if (!sheet) return [] as number[];
    const hidden = new Set(sheet.hidden_cols);
    return Array.from({ length: sheet.col_count }, (_, i) => i + 1).filter((c) => !hidden.has(c));
  }, [sheet]);
  const page0 = allList?.pages.get(0);
  /** Width the content of the first page needs per column (Excel widths are often too narrow for the viewer font). */
  const need = useMemo(() => {
    const m = new Map<number, number>();
    for (const row of page0 ?? []) {
      if (row.kind === 'note' || row.kind === 'blank') continue;
      for (const c of row.cells) {
        const t = c[2];
        if (!t || /m/.test(flagLetters(c[3]))) continue;
        const px = Math.ceil(t.length * (isNum(c[1]) ? 7.4 : 6.9) + 18);
        const capped = row.kind === 'header' ? Math.min(px, 110) : isNum(c[1]) ? Math.min(px, 180) : Math.min(px, 320);
        m.set(c[0], Math.max(m.get(c[0]) ?? 0, capped));
      }
    }
    return m;
  }, [page0]);
  const baseW = useCallback((c: number) => Math.max(36, sheet?.col_widths[c - 1] ?? 64, need.get(c) ?? 0), [sheet, need]);
  const descCol = useMemo(() => {
    if (!sheet) return 0;
    let best = cols[0] ?? 0, bw = -1;
    for (const c of cols.slice(0, 4)) { const w = baseW(c); if (w > bw) { bw = w; best = c; } }
    return best;
  }, [sheet, cols, baseW]);
  const W = useMemo(() => {
    if (!sheet) return [44];
    return [44, ...cols.map((c) => {
      const w = baseW(c);
      return c === descCol ? Math.min(w, isSheet ? 190 : 300) : Math.min(w, 240);
    })].map((w) => Math.round(w * z));
  }, [sheet, cols, descCol, isSheet, z, baseW]);
  const lefts = useMemo(() => W.reduce<number[]>((a, w, i) => { a.push(i ? a[i - 1] + W[i - 1] : 0); return a; }, []), [W]);
  const gridW = W.reduce((a, b) => a + b, 0);
  const fc = useMemo(() => {
    if (!sheet || !cols.length) return 0;
    let n = sheet.frozen.cols > 0 ? Math.min(sheet.frozen.cols, 4) : cols.indexOf(descCol) + 1;
    n = Math.max(0, Math.min(n, cols.length));
    return lefts[n] + W[n] > cw * 0.65 ? 0 : n;
  }, [sheet, cols, descCol, lefts, W, cw]);
  const gridCols = W.map((w) => `${w}px`).join(' ');

  /* ---------- header row & outline ---------- */
  const outline = useMemo(() => {
    if (sheet?.outline) return sheet.outline;
    const out: { r: number; kind: SheetRow['kind']; cells: Cell[] }[] = [];
    if (allList) for (const [, rows] of [...allList.pages.entries()].sort((a, b) => a[0] - b[0])) {
      for (const r of rows) if (r.kind === 'header' || r.kind === 'section' || r.kind === 'subtotal' || r.kind === 'total') out.push(r);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, allList, allList?.pages.size]);
  const headerRow = useMemo(() => {
    const h = outline.find((o) => o.kind === 'header' && o.r <= 60);
    if (h) return h;
    if (sheet && sheet.frozen.rows > 0 && page0) return page0.find((r) => r.r === sheet.frozen.rows && r.cells.some((c) => typeof c[1] === 'string')) ?? null;
    return null;
  }, [outline, sheet, page0]);
  const overlayHeader = filter === 'all' && !!headerRow;
  const headOffset = overlayHeader ? 0 : rh;

  /* ---------- scroller ---------- */
  const setScroller = useCallback((el: HTMLDivElement | null) => {
    scRef.current = el;
    if (!el) return;
    const ro = new ResizeObserver(() => { setVh(el.clientHeight); setCw(el.clientWidth); });
    ro.observe(el);
    setVh(el.clientHeight); setCw(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const scrollToIdx = useCallback((idx: number) => {
    const el = scRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, headOffset + idx * rh - el.clientHeight / 3);
    setSt(el.scrollTop);
  }, [headOffset, rh]);
  // A tab that was hidden (display:none) comes back with scrollTop 0: restore where it was.
  useLayoutEffect(() => {
    const el = scRef.current;
    if (el && vh > 0 && pendingIdx.current == null && Math.abs(el.scrollTop - st) > 1) el.scrollTop = st;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vh]);
  useLayoutEffect(() => {
    if (pendingIdx.current == null || !scRef.current || !vh) return;
    scrollToIdx(pendingIdx.current);
    pendingIdx.current = null;
  });

  const start = Math.max(0, Math.floor((st - headOffset) / rh) - 8);
  const end = Math.min(N, start + Math.ceil((vh || 600) / rh) + 18);

  useEffect(() => {
    if (sheetIdx == null || !sheet) return;
    fetchPage(sheetIdx, 'all', 0, reload);
    if (N === 0) return;
    for (let p = Math.floor(start / PAGE); p <= Math.floor(Math.max(start, end - 1) / PAGE); p++) fetchPage(sheetIdx, filter, p, reload);
  });

  /* ---------- jump (open at sheet + row) ---------- */
  useEffect(() => {
    if (!meta || !jump || appliedSeq.current === jumpSeq) return;
    appliedSeq.current = jumpSeq;
    let idx = sheetIdx;
    if (jump.sheet != null) {
      const want = String(jump.sheet);
      const hit = meta.sheets.find((x) => x.name === want) ?? meta.sheets.find((x) => x.name.trim().toLowerCase() === want.trim().toLowerCase());
      if (hit) idx = hit.idx;
    }
    setSi(idx);
    setFilter('all');
    setFind('');
    setSel(null);
    if (jump.row != null) {
      setHl(jump.row);
      if (isEstimate) setSel(jump.row);
      pendingIdx.current = jump.row - 1;
    }
  }, [meta, jump, jumpSeq, sheetIdx, isEstimate]);

  /* ---------- find ---------- */
  const locate = useCallback(async (r: number): Promise<number | null> => {
    if (sheetIdx == null) return null;
    if (filter === 'all') return r - 1;
    const l = list(keyFor(sheetIdx, filter));
    for (const [p, rows] of l.pages) { const i = rows.findIndex((x) => x.r === r); if (i >= 0) return p * PAGE + i; }
    const qs = new URLSearchParams({ sheet: String(sheetIdx), filter, around: String(r), limit: String(PAGE) });
    try {
      const res = await api<RowsResponse>(`${ep.rows}?${qs}`);
      l.pages.set(Math.floor(res.offset / PAGE), res.rows); l.total = res.total; setVer((v) => v + 1);
      const i = res.rows.findIndex((x) => x.r === r);
      return i >= 0 ? res.offset + i : null;
    } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetIdx, filter, reload, ep.rows, list]);

  const goMatch = useCallback(async (n: number, matches: number[]) => {
    if (!matches.length) return;
    const k = ((n % matches.length) + matches.length) % matches.length;
    setFi(k); setHl(null); setSel(null);
    const idx = await locate(matches[k]);
    if (idx != null) scrollToIdx(idx);
  }, [locate, scrollToIdx]);

  useEffect(() => {
    const q = find.trim();
    if (!q || sheetIdx == null) { setFres(null); return; }
    let off = false;
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ sheet: String(sheetIdx), q, limit: '1' });
      if (filter !== 'all') qs.set('filter', filter);
      api<RowsResponse>(`${ep.rows}?${qs}`).then((res) => {
        if (off) return;
        const m = res.matches ?? [];
        setFres({ matches: m, total: res.total });
        void goMatch(0, m);
      }).catch(() => { if (!off) setFres({ matches: [], total: 0 }); });
    }, 250);
    return () => { off = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find, sheetIdx, filter, reload, ep.rows]);

  const matchSet = useMemo(() => new Set(fres?.matches ?? []), [fres]);
  const curMatch = fres?.matches.length ? fres.matches[fi] : null;

  /* ---------- actions ---------- */
  const resetView = () => { setSt(0); if (scRef.current) scRef.current.scrollTop = 0; };
  const selectSheet = (idx: number) => { setSi(idx); setSel(null); setHl(null); setFilter('all'); setFind(''); setRowsErr(null); resetView(); };
  const toggleFilter = (f: RowFilter) => { setFilter((cur) => (cur === f ? 'all' : f)); setSel(null); resetView(); };
  const gotoRow = () => {
    const n = parseInt(gotoVal, 10);
    if (!sheet || !Number.isFinite(n) || n < 1) return;
    const r = Math.min(n, sheet.row_count);
    setFilter('all'); setFind(''); setSel(null); setHl(r);
    pendingIdx.current = r - 1;
    setVer((v) => v + 1);
  };
  const clickRow = (row: SheetRow) => {
    if (isEstimate && row.estimate_row_id) { setSel(row.r); setHl(null); }
    else { setSel(null); setHl(row.r); }
  };
  const afterSave = (r: number, document?: Record<string, unknown>) => {
    store.current.clear();
    setReload((x) => x + 1);
    setMetaTick((x) => x + 1);
    setSel(null); setHl(r);
    if (document && onEdited) onEdited(document);
  };

  useEffect(() => {
    if (sel == null) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setSel(null); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [sel]);

  /* ---------- rendering ---------- */
  if (err) return <Broken reason={err} onRetry={() => { setErr(null); setMeta(null); setAttempt((a) => a + 1); }} download={ep.download} />;
  if (!meta || !sheet) return <Loading />;

  const frozenCell = (pos: number, bg: string): CSSProperties => ({ position: 'sticky', left: lefts[pos], zIndex: 1, background: bg });
  const edge: CSSProperties = { boxShadow: '1px 0 0 var(--line)' };

  /** Cells of one row laid out on the grid: merges and text overflow span columns (within frozen / scrolling part). */
  const renderCells = (row: SheetRow, bg: string, opts: { numbersOnly?: boolean; label?: ReactNode; tag?: Marker | null } = {}) => {
    const r = row.r;
    const byCol = new Map<number, Cell>();
    for (const c of row.cells) byCol.set(c[0], c);
    const merges = sheet.merges.filter((m) => m.r1 <= r && r <= m.r2);
    const covered = (c: number) => merges.some((m) => c >= m.c1 && c <= m.c2 && !(c === m.c1 && r === m.r1));
    const out: ReactNode[] = [];
    let skipUntil = -1;
    for (let j = 0; j < cols.length; j++) {
      if (j <= skipUntil) continue;
      const c = cols[j];
      const frozen = j < fc;
      const regionEnd = frozen ? fc - 1 : cols.length - 1;
      let cell = byCol.get(c);
      if (opts.numbersOnly && cell && !isNum(cell[1]) && c !== descCol) cell = undefined;
      const isDesc = c === descCol;
      if (covered(c) && !(opts.label && isDesc)) {
        if (frozen) out.push(<div key={c} style={{ ...frozenCell(j + 1, bg), ...(j === fc - 1 ? edge : {}), gridColumn: `${j + 2} / span 1` }} />);
        continue;
      }
      let span = 1;
      const merge = merges.find((m) => m.c1 === c && m.r1 === r);
      const text = cell ? cell[2] : '';
      const fl = cell ? flagLetters(cell[3]) : '';
      if (merge) {
        while (j + span <= regionEnd && cols[j + span] <= merge.c2) span++;
      } else if (cell && text && !isNum(cell[1]) && !/[rcw]/.test(fl)) {
        while (j + span <= regionEnd && span < 8) {
          const nc = cols[j + span];
          const n = byCol.get(nc);
          if ((n && n[2]) || covered(nc) || merges.some((m) => m.c1 === nc) || (nc === descCol && opts.tag)) break;
          span++;
        }
      }
      const label = isDesc && opts.label ? opts.label : null;
      const tag = isDesc ? opts.tag : null;
      if (!cell && !frozen && !label && !tag) continue;
      if (span > 1) skipUntil = j + span - 1;
      const num = cell ? isNum(cell[1]) : false;
      const align = /r/.test(fl) || (num && !/c/.test(fl)) ? 'flex-end' : /c/.test(fl) ? 'center' : 'flex-start';
      const style: CSSProperties = {
        gridColumn: `${j + 2} / span ${span}`, display: 'flex', alignItems: 'center', justifyContent: align, gap: 6, padding: '0 8px', minWidth: 0, overflow: 'hidden',
        fontWeight: /b/.test(fl) ? 600 : undefined, fontStyle: /i/.test(fl) ? 'italic' : undefined, textDecoration: /u/.test(fl) ? 'underline' : undefined,
        ...(num ? { fontFamily: MONO, fontSize: '0.94em' } : {}),
        ...(frozen ? frozenCell(j + 1, bg) : {}),
        ...(frozen && j + span - 1 === fc - 1 ? edge : {}),
      };
      out.push(
        <div key={c} style={style} title={text && text.length > 12 ? text : undefined}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{label ?? text}</span>
          {tag && <span style={{ flex: 'none', fontFamily: MONO, fontSize: 9.5, fontWeight: 600, padding: '1px 4px', borderRadius: 3, color: TAG[tag][0], background: TAG[tag][1] }}>{tag}</span>}
        </div>,
      );
    }
    return out;
  };

  const rowStyle = (bg: string, extra: CSSProperties = {}): CSSProperties => ({
    display: 'grid', gridTemplateColumns: gridCols, height: rh, background: bg, borderBottom: '1px solid var(--line2)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', ...extra,
  });
  const numCell = (bg: string, content: ReactNode, mark = 'transparent'): ReactNode => (
    <div key="#" style={{ ...frozenCell(0, bg), gridColumn: '1 / span 1', display: 'flex', alignItems: 'center', padding: '0 8px 0 5px', borderLeft: `3px solid ${mark}`, color: 'var(--ink3)', fontFamily: MONO, fontSize: '0.88em', fontWeight: 400, ...(fc === 0 ? edge : {}) }}>{content}</div>
  );

  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const row = rowAt(i);
    if (!row) {
      rows.push(
        <div key={`p${i}`} style={rowStyle('var(--panel)')}>
          {numCell('var(--panel)', filter === 'all' ? i + 1 : '')}
          <div style={{ gridColumn: `2 / span ${Math.max(1, Math.min(cols.length, 4))}`, display: 'flex', alignItems: 'center', padding: '0 8px' }}>
            <div className={s.skel} style={{ height: 8, width: '70%', borderRadius: 4 }} />
          </div>
        </div>,
      );
      continue;
    }
    const k = row.kind;
    const mk = isEstimate ? (row.marker ?? null) : null;
    const isSel = sel === row.r, isHl = hl === row.r || curMatch === row.r;
    const bg = isSel ? 'var(--accSoft)' : isHl ? 'var(--hl)' : matchSet.has(row.r) ? 'var(--hl2)'
      : k === 'section' ? 'var(--side)' : k === 'header' ? 'var(--sunk)' : 'var(--panel)';
    rows.push(
      <div key={row.r} data-row={row.r} onClick={() => clickRow(row)} className={s.rowHover}
        style={rowStyle(bg, {
          fontWeight: k === 'item' || k === 'note' || k === 'blank' ? 400 : 600,
          color: k === 'note' ? 'var(--ink2)' : k === 'header' ? 'var(--ink2)' : undefined,
          fontSize: k === 'header' ? '0.92em' : undefined,
          cursor: 'pointer', position: 'relative', zIndex: isSel || isHl ? 1 : undefined,
        })}>
        {numCell(bg, row.r, mk ? MARK[mk] : 'transparent')}
        {renderCells(row, bg, { tag: mk })}
        {(isSel || isHl) && <div aria-hidden style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none', boxShadow: 'inset 0 0 0 1.5px var(--acc)' }} />}
      </div>,
    );
  }

  /* sticky header: the sheet's own header row (appears once the real one scrolls away), else column letters */
  const headerVisible = !overlayHeader || (headerRow ? st > (headerRow.r - 1) * rh + 1 : false);
  const header = (
    <div style={{
      position: 'sticky', top: 0, zIndex: 3, display: 'grid', gridTemplateColumns: gridCols, height: rh, background: 'var(--sunk)', borderBottom: '1px solid var(--line)',
      fontWeight: 600, color: 'var(--ink2)', fontSize: '0.92em', whiteSpace: 'nowrap', marginBottom: overlayHeader ? -rh : 0, visibility: headerVisible ? 'visible' : 'hidden',
    }}>
      <div style={{ ...frozenCell(0, 'var(--sunk)'), zIndex: 2, gridColumn: '1 / span 1', display: 'flex', alignItems: 'center', padding: '0 8px', color: 'var(--ink3)', fontFamily: MONO, fontWeight: 400, ...(fc === 0 ? edge : {}) }}>#</div>
      {headerRow
        ? renderCells({ r: headerRow.r, kind: 'header', cells: headerRow.cells.map((c) => [c[0], c[1], c[2], c[3].replace(/[fm]/g, '')] as Cell) }, 'var(--sunk)').map((el) => el)
        : cols.map((c, j) => (
          <div key={c} style={{ gridColumn: `${j + 2} / span 1`, display: 'flex', alignItems: 'center', justifyContent: 'center', ...(j < fc ? { ...frozenCell(j + 1, 'var(--sunk)'), zIndex: 2 } : {}), ...(j === fc - 1 ? edge : {}) }}>{colName(c)}</div>
        ))}
    </div>
  );

  /* sticky bottom subtotal of the section in view */
  let bar: ReactNode = null;
  if (filter !== 'all') {
    bar = (
      <div style={rowStyle('var(--sunk)', { position: 'sticky', bottom: 0, zIndex: 3, borderTop: '1px solid var(--line)', borderBottom: 0, fontWeight: 600 })}>
        {numCell('var(--sunk)', '')}
        {renderCells({ r: 0, kind: 'subtotal', cells: [] }, 'var(--sunk)', { label: `Filtered rows · ${fmtInt(N)}` })}
      </div>
    );
  } else if (outline.length && N) {
    const bottomR = Math.min(sheet.row_count, Math.max(1, Math.floor((st + (vh || 600) - rh * 2 - headOffset) / rh) + 1));
    let secR = 0;
    for (const o of outline) if (o.kind === 'section' && o.r <= bottomR) secR = o.r;
    const sub = outline.find((o) => (o.kind === 'subtotal' || o.kind === 'total') && o.r > secR && o.r >= Math.min(bottomR, secR + 1));
    if (sub && sub.cells.some((c) => isNum(c[1]))) {
      const labelCell = sub.cells.find((c) => typeof c[1] === 'string' && c[2]);
      bar = (
        <div style={rowStyle('var(--sunk)', { position: 'sticky', bottom: 0, zIndex: 3, borderTop: '1px solid var(--line)', borderBottom: 0, fontWeight: 600 })}>
          {numCell('var(--sunk)', '')}
          {renderCells({ r: sub.r, kind: 'subtotal', cells: sub.cells.filter((c) => isNum(c[1])).map((c) => [c[0], c[1], c[2], c[3].replace(/[fm]/g, '')] as Cell) }, 'var(--sunk)', {
            label: labelCell ? labelCell[2] : `Row ${sub.r}`,
          })}
        </div>
      );
    }
  }

  const padTop = start * rh, padBot = Math.max(0, (N - end) * rh);
  const totalRows = visibleSheets.reduce((a, x) => a + x.row_count, 0);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div style={isSheet ? toolbarPhone : toolbar} className={isSheet ? s.noScrollbar : undefined}>
        <SearchBox label="Find" value={find} onChange={(v) => { setFind(v); setFi(0); }} placeholder={findHint(lang)}
          count={find.trim() && fres ? (fres.total ? `${fi + 1} of ${fmtInt(fres.total)}` : 'No matches') : ''}
          onKeyDown={(e) => { if (e.key === 'Enter' && fres) { e.preventDefault(); void goMatch(fi + (e.shiftKey ? -1 : 1), fres.matches); } }}
          style={{ minWidth: 200 }}>
          <button type="button" aria-label="Previous match" className={s.ghost} onClick={() => fres && goMatch(fi - 1, fres.matches)} style={{ width: 22, height: 22, border: 0, borderRadius: 4, background: 'transparent', color: 'var(--ink2)', cursor: 'pointer' }}>↑</button>
          <button type="button" aria-label="Next match" className={s.ghost} onClick={() => fres && goMatch(fi + 1, fres.matches)} style={{ width: 22, height: 22, border: 0, borderRadius: 4, background: 'transparent', color: 'var(--ink2)', cursor: 'pointer' }}>↓</button>
        </SearchBox>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 8px 0 10px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--bg)' }}>
          <span style={{ color: 'var(--ink3)', fontSize: 12, whiteSpace: 'nowrap' }}>Go to row</span>
          <input value={gotoVal} inputMode="numeric" aria-label="Go to row" placeholder={String(Math.min(58, sheet.row_count || 1))}
            onChange={(e) => setGotoVal(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter') gotoRow(); }}
            style={{ width: 48, border: 0, outline: 0, background: 'transparent', color: 'var(--ink)', fontFamily: MONO, fontSize: 12 }} />
        </div>
        <Zoom zi={zi} setZi={setZi} />
      </div>
      {isEstimate && (
        <div style={{ ...(isSheet ? toolbarPhone : toolbar), gap: 6 }} className={isSheet ? s.noScrollbar : undefined}>
          <span style={{ fontSize: 12, color: 'var(--ink3)', marginRight: 2, whiteSpace: 'nowrap' }}>Show only</span>
          {FILTERS.map(([f, label, mark]) => {
            const on = filter === f;
            return (
              <button key={f} type="button" onClick={() => toggleFilter(f)} aria-pressed={on}
                style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px', borderRadius: 14, border: `1px solid ${on ? 'var(--acc)' : 'var(--line)'}`, background: on ? 'var(--accSoft)' : 'var(--panel)', color: on ? 'var(--accInk)' : 'var(--ink2)', font: 'inherit', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>
                <span style={{ width: 3, height: 12, borderRadius: 2, background: mark }} />{label}
                <span style={{ fontFamily: MONO, fontSize: 11, opacity: 0.8 }}>{fmtInt(filterCount(f))}</span>
              </button>
            );
          })}
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--ink3)', whiteSpace: 'nowrap', fontFamily: MONO }}>
            {fmtInt(totalRows)} rows in {visibleSheets.length} sheet{visibleSheets.length === 1 ? '' : 's'}
          </span>
        </div>
      )}
      {rowsErr && (
        <div role="alert" style={{ flex: 'none', padding: '6px 12px', fontSize: 12, color: 'var(--err)', background: 'var(--errSoft)', display: 'flex', gap: 8 }}>
          <span style={{ flex: 1 }}>{rowsErr}</span>
          <button type="button" onClick={() => { setRowsErr(null); store.current.clear(); setReload((x) => x + 1); }} style={{ border: 0, background: 'transparent', color: 'var(--accInk)', font: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}>Try again</button>
        </div>
      )}

      <div ref={setScroller} onScroll={(e) => setSt(e.currentTarget.scrollTop)} tabIndex={0} aria-label={`Sheet ${sheet.name}`}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative', background: 'var(--panel)', fontSize: fs, outline: 'none' }}>
        {N === 0 && cols.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--ink3)', fontSize: 13 }}>This sheet is empty.</div>
        ) : (
          <div style={{ width: gridW, minWidth: '100%', position: 'relative' }}>
            {header}
            <div style={{ height: padTop }} />
            {rows}
            {N === 0 && filter !== 'all' && <div style={{ padding: '16px 12px', color: 'var(--ink3)', fontSize: 13, position: 'sticky', left: 0, width: Math.min(cw, gridW) }}>No rows match this filter on this sheet.</div>}
            <div style={{ height: padBot }} />
            {bar}
          </div>
        )}
      </div>

      <div style={{ flex: 'none', display: 'flex', alignItems: 'stretch', borderTop: '1px solid var(--line)', background: 'var(--side)', minHeight: 38 }}>
        <div className={s.noScrollbar} style={{ display: 'flex', alignItems: 'stretch', overflowX: 'auto', flex: 1, minWidth: 0 }}>
          {visibleSheets.map((x) => {
            const on = x.idx === sheetIdx;
            return (
              <button key={x.idx} type="button" onClick={() => selectSheet(x.idx)} aria-pressed={on}
                style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px', borderLeft: 0, borderBottom: 0, borderRight: '1px solid var(--line)', borderTop: `2px solid ${on ? 'var(--acc)' : 'transparent'}`, background: on ? 'var(--panel)' : 'transparent', color: on ? 'var(--ink)' : 'var(--ink2)', font: 'inherit', fontSize: 12.5, fontWeight: on ? 600 : 400, cursor: 'pointer' }}>
                {x.name}<span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--ink3)', fontWeight: 400 }}>{fmtInt(x.row_count)}</span>
              </button>
            );
          })}
        </div>
        {total && !isSheet && (
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px', fontSize: 12, color: 'var(--ink2)', whiteSpace: 'nowrap' }}>
            {total.label}<b style={{ fontFamily: MONO, fontWeight: 600, color: 'var(--ink)' }}>{total.value}</b>
          </div>
        )}
      </div>

      {isEstimate && sel != null && (
        <RowInspector documentId={doc.id} sheet={sheet.name} row={sel} isSheet={isSheet} currency={currency}
          onClose={() => setSel(null)} onMissing={() => { setHl(sel); setSel(null); }} onSaved={afterSave} onOpenDoc={onOpenDoc} />
      )}
    </div>
  );
}
