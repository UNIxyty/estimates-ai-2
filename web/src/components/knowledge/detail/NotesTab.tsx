'use client';

import { useState } from 'react';
import { api } from '@/lib/client';
import { useUser } from '@/components/UserContext';
import { Spinner } from '@/components/ui';
import styles from '../knowledge.module.css';
import type { Detail, Note } from './types';

export function NotesTab({ d, canEdit, onChanged }: { d: Detail; canEdit: boolean; onChanged: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/files/${d.file.id}/notes`, { method: 'POST', json: { text: t } });
      setText('');
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  return (
    <>
      <div style={{ fontSize: 14, color: 'var(--ink2)' }}>Short notes the agent wrote for itself while reading this file. They guide how it uses the file.</div>
      {d.notes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {d.notes.map((n) => <NoteRow key={n.id} fileId={d.file.id} n={n} canEditFile={canEdit} onChanged={onChanged} />)}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="New note"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add(); }}
          placeholder="Add a note for the agent, e.g. “Never add freight to cable prices.”"
          style={{ flex: 1, minWidth: 220, padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 14, resize: 'vertical', outlineColor: 'var(--acc)' }} />
        <button type="button" onClick={add} disabled={busy || !text.trim()} className="hv-accbg"
          style={{ height: 40, padding: '0 16px', border: 0, borderRadius: 10, background: 'var(--acc)', color: '#fff', font: 'inherit', fontWeight: 600, fontSize: 13.5, cursor: busy || !text.trim() ? 'default' : 'pointer', opacity: text.trim() ? 1 : 0.6, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {busy && <Spinner size={12} color="#fff" />}Add note
        </button>
      </div>
      {err && <div role="alert" style={{ fontSize: 13, color: 'var(--err)' }}>{err}</div>}
    </>
  );
}

function NoteRow({ fileId, n, canEditFile, onChanged }: { fileId: string; n: Note; canEditFile: boolean; onChanged: () => void }) {
  const user = useUser();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(n.text);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mine = n.source === 'user';
  const canEdit = canEditFile || (mine && n.created_by === user.id);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try { await fn(); onChanged(); return true; } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); }
  }
  async function toggle() {
    if (!editing) { setText(n.text); setEditing(true); return; }
    const t = text.trim();
    if (!t || t === n.text) { setEditing(false); return; }
    if (await run(() => api(`/api/files/${fileId}/notes/${n.id}`, { method: 'PATCH', json: { text: t } }))) setEditing(false);
  }

  const by = mine ? 'Your note' : 'Agent';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--panel)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ flex: 'none', marginTop: 2, display: 'inline-flex', gap: 4 }}>
          <span title={mine && n.created_by_name ? `Added by ${n.created_by_name}` : undefined} style={{ fontSize: 11, fontWeight: 600, color: mine ? 'var(--accInk)' : 'var(--ink2)', background: mine ? 'var(--accSoft)' : 'var(--sunk)', padding: '1px 6px', borderRadius: 4 }}>{by}</span>
          {!mine && n.edited && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accInk)', background: 'var(--accSoft)', padding: '1px 6px', borderRadius: 4 }}>Edited</span>}
        </span>
        {editing
          ? <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} autoFocus aria-label="Note"
              style={{ flex: 1, minWidth: 180, padding: '8px 10px', border: '1px solid var(--acc)', borderRadius: 8, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 14.5, resize: 'vertical', outline: 0 }} />
          : <span style={{ flex: 1, minWidth: 180, fontSize: 14.5, lineHeight: 1.55 }}>{n.text}</span>}
        {canEdit && (
          <span style={{ flex: 'none', display: 'flex' }}>
            <button type="button" onClick={toggle} disabled={busy} className="hv-sunk" style={{ height: 28, padding: '0 10px', border: 0, borderRadius: 7, background: 'transparent', color: 'var(--accInk)', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>{editing ? 'Save' : 'Edit'}</button>
            {editing
              ? <button type="button" onClick={() => setEditing(false)} className="hv-sunk" style={{ height: 28, padding: '0 10px', border: 0, borderRadius: 7, background: 'transparent', color: 'var(--ink3)', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              : <button type="button" disabled={busy} className={styles.errText}
                  onClick={() => run(() => api(`/api/files/${fileId}/notes/${n.id}`, { method: 'DELETE' }))}
                  style={{ height: 28, padding: '0 10px', border: 0, borderRadius: 7, background: 'transparent', color: 'var(--ink3)', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>Delete</button>}
          </span>
        )}
      </div>
      {err && <div role="alert" style={{ fontSize: 13, color: 'var(--err)' }}>{err}</div>}
    </div>
  );
}
