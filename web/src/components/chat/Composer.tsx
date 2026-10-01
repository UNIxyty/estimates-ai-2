'use client';

/**
 * design/Composer.dc.html (DESIGN.md §5.3): file chips, auto-growing textarea, + attach (native picker →
 * POST /api/uploads), drag-and-drop overlay, "/" references popover (GET /api/picker?all=1, grouped by tag,
 * status dot, language tag, multi-select, ↑↓ Enter Esc), quiet hint (GET /api/composer-hint), send button.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { KindText, MONO, Spinner } from '@/components/ui';
import type { DocRef } from '@/components/viewer/types';
import type { FileRef } from './types';
import s from './Chat.module.css';

export interface ComposerChip {
  key: string;
  /** upload = chat attachment (sent as attachment_ids), file = knowledge file (reference_ids), document = agent output (context only). */
  source: 'upload' | 'file' | 'document';
  id?: string;
  name: string;
  role: string;
  language?: string | null;
  uploading?: boolean;
  error?: string;
}

export interface ComposerHandle {
  focus: () => void;
  addChip: (c: ComposerChip) => void;
  setText: (t: string) => void;
  /** Opens the native file picker. */
  attach: () => void;
}

const GROUP_LABEL: Record<string, string> = {
  reference_estimate: 'Priced estimates (reference)',
  hourly_norms: 'Hourly norms',
  price_list: 'Price lists',
  other: 'Other',
};
const STATUS: Record<string, [string, string]> = {
  analysed: ['Analysed', 'var(--ok)'],
  queued: ['Queued', 'var(--ink3)'],
  reading: ['Reading', 'var(--acc)'],
  analysing: ['Analysing', 'var(--acc)'],
  failed: ['Failed', 'var(--err)'],
};
const UPLOAD_ACCEPT = '.xlsx,.xls,.docx,.pdf,.txt,.csv';
export const uploadRole = (name: string) => (/\.xlsx?$/i.test(name) ? 'Blank' : 'Work list');

let pickerCache: Promise<{ tag: string; files: FileRef[] }[]> | null = null;
export function loadPicker(fresh = false) {
  if (!pickerCache || fresh)
    pickerCache = api<{ groups: { tag: string; files: FileRef[] }[] }>('/api/picker?all=1').then((r) => r.groups).catch(() => {
      pickerCache = null;
      return [];
    });
  return pickerCache;
}

export interface ComposerProps {
  conversationId?: string | null;
  placeholder?: string;
  disabled?: boolean;
  /** A run is working: typing is allowed, sending is not (the API would answer 409 run_active). */
  busy?: boolean;
  /** Returns true when the message was accepted (the composer then clears). */
  onSend: (text: string, chips: ComposerChip[]) => Promise<boolean>;
  onOpenDoc?: (doc: DocRef) => void;
  autoFocus?: boolean;
  error?: string | null;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { conversationId, placeholder, disabled, busy, onSend, onOpenDoc, autoFocus, error },
  ref,
) {
  const [text, setText] = useState('');
  const [chips, setChips] = useState<ComposerChip[]>([]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [viaSlash, setViaSlash] = useState(false);
  const [drag, setDrag] = useState(false);
  const [groups, setGroups] = useState<{ tag: string; files: FileRef[] }[]>([]);
  const [hint, setHint] = useState('Auto model');
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ text: string }>('/api/composer-hint').then((h) => h.text && setHint(h.text)).catch(() => {});
    loadPicker().then(setGroups);
  }, []);
  useEffect(() => {
    if (autoFocus) ta.current?.focus();
  }, [autoFocus]);

  const focus = useCallback(() => setTimeout(() => ta.current?.focus(), 20), []);
  useImperativeHandle(ref, () => ({
    focus,
    addChip: (c) => {
      setChips((cs) => (cs.some((x) => x.source === c.source && x.id === c.id) ? cs : [...cs, c]));
      focus();
    },
    setText: (t) => { setText(t); focus(); },
    attach: () => fileInput.current?.click(),
  }), [focus]);

  // Auto-grow up to ~8 lines.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    if (!text) return; // empty: natural height (a long placeholder must not stretch it)
    el.style.height = `${Math.min(el.scrollHeight, 196)}px`;
  }, [text]);

  // ---------------------------------------------------------------- picker
  const flat = useMemo(() => {
    const qq = q.toLowerCase();
    return groups
      .map((g) => ({ tag: g.tag, files: g.files.filter((f) => f.original_name.toLowerCase().includes(qq)) }))
      .filter((g) => g.files.length);
  }, [groups, q]);
  const items = useMemo(() => flat.flatMap((g) => g.files), [flat]);
  const cur = Math.min(idx, Math.max(0, items.length - 1));
  const selectedRefs = chips.filter((c) => c.source === 'file');

  const toggleFile = (f: FileRef) => {
    if ((f.status ?? 'analysed') !== 'analysed') return;
    setChips((cs) =>
      cs.some((c) => c.source === 'file' && c.id === f.id)
        ? cs.filter((c) => !(c.source === 'file' && c.id === f.id))
        : [...cs, { key: `file:${f.id}`, source: 'file', id: f.id, name: f.original_name, role: 'Reference', language: f.language }],
    );
  };
  const openPicker = () => {
    loadPicker(true).then(setGroups);
    setOpen(true);
    setQ('');
    setIdx(0);
    setViaSlash(false);
    setTimeout(() => search.current?.focus(), 30);
  };
  const closePicker = () => {
    if (viaSlash) setText((t) => t.replace(/(^|\s)\/[^\s]*$/, '$1'));
    setOpen(false);
    setQ('');
    setViaSlash(false);
    focus();
  };
  /** Next selectable row in direction d (files still analysing or failed are skipped). */
  const step = (d: 1 | -1) => {
    const n = items.length;
    for (let k = 1; k <= n; k++) {
      const j = (((cur + d * k) % n) + n) % n;
      if ((items[j].status ?? 'analysed') === 'analysed') return j;
    }
    return cur;
  };
  const pickerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(step(1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(step(-1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[cur]) toggleFile(items[cur]); }
    else if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
    else return false;
    return true;
  };
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cur}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cur, open]);

  // ---------------------------------------------------------------- files
  const upload = async (files: File[]) => {
    for (const f of files) {
      const key = `up:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      setChips((cs) => [...cs, { key, source: 'upload', name: f.name, role: uploadRole(f.name), uploading: true }]);
      const fd = new FormData();
      fd.set('file', f);
      if (conversationId) fd.set('conversation_id', conversationId);
      try {
        const r = await api<{ upload: { id: string; original_name: string } }>('/api/uploads', { method: 'POST', body: fd });
        setChips((cs) => cs.map((c) => (c.key === key ? { ...c, id: r.upload.id, uploading: false } : c)));
      } catch (err) {
        setChips((cs) => cs.map((c) => (c.key === key ? { ...c, uploading: false, error: (err as Error).message } : c)));
      }
    }
  };

  // ---------------------------------------------------------------- send
  const ready = chips.filter((c) => !c.uploading && !c.error);
  const canSend = !disabled && !busy && !sending && !chips.some((c) => c.uploading) && (!!text.trim() || ready.some((c) => c.source === 'upload'));
  const doSend = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const ok = await onSend(text.trim(), ready);
      if (ok) {
        setText('');
        setChips([]);
        setOpen(false);
      }
    } finally {
      setSending(false);
    }
  };

  const onText = (v: string) => {
    setText(v);
    const m = v.match(/(^|\s)\/([^\s]*)$/);
    if (m) {
      if (!open) loadPicker(true).then(setGroups);
      setOpen(true);
      setQ(m[2]);
      setViaSlash(true);
      setIdx(0);
    } else if (viaSlash) {
      setOpen(false);
      setViaSlash(false);
    }
  };

  const boxLine = drag ? 'var(--acc)' : 'var(--line)';
  return (
    <div style={{ position: 'relative', width: '100%', color: 'var(--ink)' }}>
      {open && (
        <div role="dialog" aria-label="Pick reference files"
          style={{ position: 'absolute', left: 0, right: 0, bottom: 'calc(100% + 8px)', zIndex: 30, maxWidth: 460, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12, boxShadow: '0 12px 40px rgba(16,24,40,0.16)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--line2)' }}>
            <span style={{ fontFamily: MONO, color: 'var(--accInk)', fontWeight: 600 }}>/</span>
            <input ref={search} value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} onKeyDown={(e) => { pickerKey(e); }}
              placeholder="Search reference files" aria-label="Search reference files"
              style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--ink)', font: 'inherit', fontSize: 13.5 }} />
            <span style={{ fontSize: 11.5, color: 'var(--ink3)', whiteSpace: 'nowrap' }}>{selectedRefs.length} selected</span>
          </div>
          <div ref={listRef} role="listbox" aria-multiselectable="true" className="scroll-thin" style={{ maxHeight: 300, overflow: 'auto', padding: '4px 0' }}>
            {(() => {
              let k = 0;
              return flat.map((g) => (
                <div key={g.tag}>
                  <div style={{ padding: '8px 14px 4px', fontSize: 11.5, fontWeight: 500, color: 'var(--ink3)' }}>{GROUP_LABEL[g.tag] ?? g.tag}</div>
                  {g.files.map((f) => {
                    const i = k++;
                    const on = selectedRefs.some((c) => c.id === f.id);
                    const st = f.status ?? 'analysed';
                    const dis = st !== 'analysed';
                    const [sl, sfg] = STATUS[st] ?? [st, 'var(--ink3)'];
                    return (
                      <div key={f.id} data-idx={i} role="option" aria-selected={on} aria-disabled={dis}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setIdx(i); toggleFile(f); }} onMouseEnter={() => i !== cur && setIdx(i)}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px', background: i === cur ? 'var(--sunk)' : 'transparent', cursor: dis ? 'not-allowed' : 'pointer', opacity: dis ? 0.55 : 1 }}>
                        <span style={{ width: 16, height: 16, flex: 'none', borderRadius: 4, border: `1.5px solid ${on ? 'var(--acc)' : 'var(--ink3)'}`, background: on ? 'var(--acc)' : 'transparent', color: '#fff', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{on ? '✓' : ''}</span>
                        <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 13 }}>{f.original_name}</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: sfg, whiteSpace: 'nowrap' }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />{sl}
                        </span>
                        {f.language && (
                          <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', height: 17, padding: '0 5px', border: '1px solid var(--line)', borderRadius: 4, fontFamily: MONO, fontSize: 10, fontWeight: 600, color: 'var(--ink2)' }}>{f.language.toUpperCase().slice(0, 2)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ));
            })()}
            {!items.length && (
              <div style={{ padding: '16px 14px', color: 'var(--ink3)', fontSize: 13 }}>
                {groups.length ? <>No files match “{q}”.</> : 'No reference files yet.'}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 14, padding: '8px 14px', borderTop: '1px solid var(--line2)', background: 'var(--side)', fontSize: 11.5, color: 'var(--ink3)' }}>
            <span><b style={{ fontFamily: MONO, fontWeight: 500, color: 'var(--ink2)' }}>↑↓</b> move</span>
            <span><b style={{ fontFamily: MONO, fontWeight: 500, color: 'var(--ink2)' }}>Enter</b> select</span>
            <span><b style={{ fontFamily: MONO, fontWeight: 500, color: 'var(--ink2)' }}>Esc</b> close</span>
            <button type="button" onClick={closePicker} style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: 'var(--accInk)', font: 'inherit', fontWeight: 500, cursor: 'pointer' }}>Done</button>
          </div>
        </div>
      )}

      <div
        onDragOver={(e) => { if (disabled) return; e.preventDefault(); if (!drag) setDrag(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (!disabled) upload(Array.from(e.dataTransfer.files || [])); }}
        style={{ border: `1px solid ${boxLine}`, borderRadius: 18, background: 'var(--panel)', boxShadow: '0 1px 2px rgba(16,24,40,0.04),0 6px 20px rgba(16,24,40,0.05)', display: 'flex', flexDirection: 'column', opacity: disabled ? 0.6 : 1 }}>
        {chips.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '12px 14px 0' }}>
            {chips.map((c) => (
              <span key={c.key} title={c.error || undefined}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 4px 0 10px', border: `1px solid ${c.error ? 'var(--err)' : 'var(--line)'}`, borderRadius: 8, background: 'var(--bg)', fontSize: 12.5, maxWidth: 260 }}>
                {c.uploading ? <Spinner size={11} /> : <KindText name={c.name} />}
                <button type="button" className={s.chipName} disabled={!c.id}
                  onClick={() => c.id && onOpenDoc?.({ source: c.source, id: c.id, name: c.name, language: c.language })}
                  style={{ border: 0, padding: 0, background: 'transparent', color: 'var(--ink)', font: 'inherit', cursor: c.id ? 'pointer' : 'default', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{c.name}</button>
                <span style={{ fontSize: 11, color: c.error ? 'var(--err)' : 'var(--ink3)', whiteSpace: 'nowrap' }}>{c.error ? 'Upload failed' : c.uploading ? 'Uploading…' : c.role}</span>
                <button type="button" title="Remove" aria-label={`Remove ${c.name}`} className="hv-sunk hv-ink"
                  onClick={() => setChips((cs) => cs.filter((x) => x.key !== c.key))}
                  style={{ width: 20, height: 20, flex: 'none', border: 0, borderRadius: 5, background: 'transparent', color: 'var(--ink3)', fontSize: 14, lineHeight: 1, cursor: 'pointer' }}>×</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          className={s.textarea}
          value={text}
          rows={1}
          disabled={disabled}
          aria-label="Message"
          placeholder={placeholder || 'Message the agent. Type / to add reference files.'}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (open && viaSlash && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) { pickerKey(e); return; }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); doSend(); }
          }}
          onPaste={(e) => {
            const fs = Array.from(e.clipboardData?.files || []);
            if (fs.length && !disabled) { e.preventDefault(); upload(fs); }
          }}
          style={{ border: 0, outline: 0, resize: 'none', background: 'transparent', color: 'var(--ink)', font: 'inherit', fontSize: 15, lineHeight: 1.5, padding: '14px 16px 6px', minHeight: 52, overflowY: 'auto' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 10px', minWidth: 0 }}>
          <button type="button" title="Attach files" aria-label="Attach files" className="hv-sunk" disabled={disabled} onClick={() => fileInput.current?.click()}
            style={{ width: 34, height: 34, flex: 'none', borderRadius: 10, border: '1px solid var(--line)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink2)', fontSize: 18, cursor: disabled ? 'not-allowed' : 'pointer' }}>+</button>
          <input ref={fileInput} type="file" multiple hidden accept={UPLOAD_ACCEPT}
            onChange={(e) => { upload(Array.from(e.target.files || [])); e.target.value = ''; }} />
          <button type="button" className="hv-sunk" disabled={disabled} onClick={() => (open ? closePicker() : openPicker())}
            style={{ height: 34, padding: '0 10px', border: 0, borderRadius: 10, background: 'transparent', color: 'var(--ink2)', font: 'inherit', fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
            <span style={{ fontFamily: MONO, border: '1px solid var(--line)', borderRadius: 4, padding: '0 5px', fontSize: 11.5 }}>/</span>References
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: error ? 'var(--err)' : 'var(--ink3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }} role={error ? 'alert' : undefined}>
            {error || (busy ? 'The agent is working. Stop it or wait for the answer.' : hint)}
          </span>
          <button type="button" title="Send" aria-label="Send" onClick={doSend} disabled={!canSend}
            style={{ width: 34, height: 34, flex: 'none', border: 0, borderRadius: 10, background: canSend ? 'var(--acc)' : 'var(--line)', color: '#fff', fontSize: 17, cursor: canSend ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {sending ? <Spinner size={14} color="#fff" /> : '↑'}
          </button>
        </div>
      </div>
      {drag && (
        <div style={{ position: 'absolute', inset: 0, border: '2px dashed var(--acc)', borderRadius: 18, background: 'var(--accSoft)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accInk)', fontWeight: 600, pointerEvents: 'none' }}>
          Drop files to attach
        </div>
      )}
    </div>
  );
});
