'use client';

/**
 * docx view (design/DocViewer.dc.html, docx branch): the document rendered as HTML by the worker (mammoth +
 * allowlist sanitiser) on a white page, with search highlighting (Enter / Shift+Enter move between matches).
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { Broken, Loading, SearchBox, errReason, toolbar, toolbarPhone } from './parts';
import s from './Viewer.module.css';

export function DocxView({ src, download, isSheet }: { src: string; download: string; isSheet: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [q, setQ] = useState('');
  const [count, setCount] = useState(0);
  const [cur, setCur] = useState(0);
  const pageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let off = false;
    setHtml(null); setErr(null);
    api<{ html: string }>(src).then((r) => { if (!off) setHtml(r.html ?? ''); }).catch((e) => { if (!off) setErr(errReason(e)); });
    return () => { off = true; };
  }, [src, attempt]);

  // Re-render the sanitised HTML and wrap matches in <mark>.
  useEffect(() => {
    const el = pageRef.current;
    if (!el || html == null) return;
    el.innerHTML = html;
    const needle = q.trim().toLowerCase();
    if (!needle) { setCount(0); setCur(0); return; }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    let found = 0;
    for (const node of nodes) {
      const text = node.data;
      const low = text.toLowerCase();
      let i = low.indexOf(needle);
      if (i < 0) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      while (i >= 0) {
        if (i > last) frag.appendChild(document.createTextNode(text.slice(last, i)));
        const m = document.createElement('mark');
        m.textContent = text.slice(i, i + needle.length);
        frag.appendChild(m);
        found++;
        last = i + needle.length;
        i = low.indexOf(needle, last);
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode?.replaceChild(frag, node);
    }
    setCount(found);
    setCur(0);
  }, [html, q]);

  useEffect(() => {
    const el = pageRef.current;
    if (!el || !count) return;
    const marks = el.querySelectorAll('mark');
    marks.forEach((m, i) => { if (i === cur) m.setAttribute('data-current', '1'); else m.removeAttribute('data-current'); });
    marks[cur]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [cur, count, html, q]);

  if (err) return <Broken reason={err} onRetry={() => setAttempt((a) => a + 1)} download={download} />;
  if (html == null) return <Loading />;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={isSheet ? toolbarPhone : toolbar} className={isSheet ? s.noScrollbar : undefined}>
        <SearchBox label="Search" value={q} onChange={setQ} placeholder="e.g. cable tray"
          count={q.trim() ? (count ? `${count} match${count === 1 ? '' : 'es'}` : 'No matches') : ''}
          onKeyDown={(e) => { if (e.key === 'Enter' && count) { e.preventDefault(); setCur((c) => (c + (e.shiftKey ? -1 : 1) + count) % count); } }} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--sunk)', padding: isSheet ? '12px 8px' : '24px 16px' }}>
        <div style={{ maxWidth: 680, margin: '0 auto', background: '#fff', color: '#1b1d21', boxShadow: '0 1px 3px rgba(0,0,0,0.12),0 8px 24px rgba(0,0,0,0.08)', padding: isSheet ? '24px 20px' : '48px 56px' }}>
          {html.trim() ? <div ref={pageRef} className={s.docx} /> : <div style={{ color: '#8a9099', fontSize: 13 }}>This document has no text to show.</div>}
        </div>
      </div>
    </div>
  );
}
