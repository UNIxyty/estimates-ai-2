'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, when } from '@/lib/client';
import { useUser } from '@/components/UserContext';
import { DocViewer } from '@/components/DocViewer';
import { TAG_LABELS } from '@/components/knowledge/UploadKnowledge';

export function FileDetail({ fileId }: { fileId: string }) {
  const user = useUser();
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api(`/api/files/${fileId}`).then(setD).catch((e: ApiError) => setError(e.status === 404 ? 'File not found.' : e.message));
  }, [fileId]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!d || !['queued', 'reading', 'analysing'].includes(d.file.status)) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [d, load]);

  if (error) return <p role="alert">{error}</p>;
  if (!d) return <p>Loading…</p>;
  const f = d.file;
  const canEdit = user.role === 'admin' || f.uploaded_by === user.id;

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      load();
    } catch (e: any) {
      alert(e.message);
    }
  }

  return (
    <>
      <p><Link href="/knowledge">← Knowledge</Link></p>
      <h1>{f.original_name}</h1>
      <p>
        Status: {f.status} {f.status !== 'analysed' && f.status !== 'failed' && <>({f.progress}%)</>}
        {f.fail_reason && <> — {f.fail_reason}</>} · Uploaded {when(f.created_at)} by {f.uploaded_by_name || '—'} · Language: {f.language || '—'}
      </p>
      <p>
        <label>
          Type{' '}
          <select value={f.tag} disabled={!canEdit} onChange={(e) => act(() => api(`/api/files/${fileId}`, { method: 'PATCH', json: { tag: e.target.value } }))}>
            {Object.entries(TAG_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>{' '}
        <a href={`/api/files/${fileId}/download`}>Download original</a>{' '}
        {canEdit && <button type="button" onClick={() => act(() => api(`/api/files/${fileId}/reanalyse`, { method: 'POST' }))}>Re-analyse</button>}{' '}
        {canEdit && (
          <button
            type="button"
            onClick={async () => {
              const p = await api<Record<string, number>>(`/api/files/${fileId}/forget-preview`);
              if (confirm(`Delete and forget ${p.price_items} price items, ${p.norms} norms, ${p.logic} logic sentences, ${p.notes} notes, ${p.embeddings} embeddings (used in ${p.used_in} conversations)?`)) {
                await api(`/api/files/${fileId}`, { method: 'DELETE' });
                window.location.href = '/knowledge';
              }
            }}
          >
            Delete…
          </button>
        )}
      </p>
      <p>Counts: {JSON.stringify(d.counts)}</p>

      <h2>Sheets</h2>
      <ul>
        {d.sheets.map((s: any) => (
          <li key={s.id}>
            {s.name} ({s.kind}) — {s.row_count} rows{s.currency ? `, ${s.currency}` : ''}
            {d.sections.filter((x: any) => x.sheet_id === s.id).length > 0 && (
              <ul>
                {d.sections.filter((x: any) => x.sheet_id === s.id).map((x: any) => (
                  <li key={x.id}>{x.title} (rows {x.row_start}–{x.row_end}){x.hourly_rate ? `, rate ${x.hourly_rate}` : ''}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      <h2>Calculation logic</h2>
      {d.logic.length === 0 && <p>None yet.</p>}
      <ul>
        {d.logic.map((l: any) => <LogicRow key={l.id} fileId={fileId} logic={l} canEdit={canEdit} onSaved={load} />)}
      </ul>

      <h2>Agent notes</h2>
      <ul>
        {d.notes.map((n: any) => (
          <NoteRow key={n.id} fileId={fileId} note={n} canEdit={canEdit || (n.source === 'user' && n.created_by === user.id)} onSaved={load} />
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const text = String(new FormData(form).get('text') || '');
          act(() => api(`/api/files/${fileId}/notes`, { method: 'POST', json: { text } })).then(() => form.reset());
        }}
      >
        <label>Add a note <input name="text" required /></label> <button type="submit">Add</button>
      </form>

      <h2>Used in</h2>
      <p>{d.usedIn.total} conversation(s){d.usedIn.others > 0 && <> — {d.usedIn.others} by other people</>}</p>
      <ul>
        {d.usedIn.mine.map((u: any) => (
          <li key={u.conversation_id}><Link href={`/chat/${u.conversation_id}`}>{u.title}</Link> — {u.rows_used} rows, {when(u.last_used)}</li>
        ))}
      </ul>

      <Items fileId={fileId} canEdit={canEdit} />

      <h2>Original</h2>
      {f.ext === 'pdf' && <p><a href={`/api/files/${fileId}/view/raw`} target="_blank" rel="noreferrer">Open PDF</a></p>}
      {f.ext === 'docx' && <DocxHtml fileId={fileId} />}
      {(f.ext === 'xlsx' || f.ext === 'xls') && <DocViewer kind="file" id={fileId} />}
    </>
  );
}

function LogicRow({ fileId, logic, canEdit, onSaved }: { fileId: string; logic: any; canEdit: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(logic.effective_sentence);
  async function save(value: string | null) {
    await api(`/api/files/${fileId}/logic/${logic.id}`, { method: 'PATCH', json: { override_sentence: value } }).catch((e) => alert(e.message));
    setEditing(false);
    onSaved();
  }
  return (
    <li>
      <small>[{logic.kind}{logic.sheet_name ? ` · ${logic.sheet_name}` : ''}{logic.section_title ? ` · ${logic.section_title}` : ''}]</small>{' '}
      {editing ? (
        <>
          <input value={text} onChange={(e) => setText(e.target.value)} size={80} /> <button type="button" onClick={() => save(text)}>Save</button>{' '}
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        </>
      ) : (
        <>
          {logic.effective_sentence} {logic.edited && <em>(Edited)</em>}{' '}
          {canEdit && <button type="button" onClick={() => setEditing(true)}>Edit</button>}{' '}
          {canEdit && logic.edited && <button type="button" onClick={() => save(null)}>Revert</button>}
        </>
      )}
    </li>
  );
}

function NoteRow({ fileId, note, canEdit, onSaved }: { fileId: string; note: any; canEdit: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  return (
    <li>
      {note.label && <b>{note.label}: </b>}
      {editing ? (
        <>
          <input value={text} onChange={(e) => setText(e.target.value)} size={80} />{' '}
          <button type="button" onClick={async () => { await api(`/api/files/${fileId}/notes/${note.id}`, { method: 'PATCH', json: { text } }).catch((e) => alert(e.message)); setEditing(false); onSaved(); }}>Save</button>
        </>
      ) : (
        <>
          {note.text}{' '}
          {canEdit && <button type="button" onClick={() => setEditing(true)}>Edit</button>}{' '}
          {canEdit && <button type="button" onClick={async () => { await api(`/api/files/${fileId}/notes/${note.id}`, { method: 'DELETE' }).catch((e) => alert(e.message)); onSaved(); }}>Delete</button>}
        </>
      )}
    </li>
  );
}

function Items({ fileId, canEdit }: { fileId: string; canEdit: boolean }) {
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<any>(null);
  const limit = 50;
  const load = useCallback(() => {
    const qs = new URLSearchParams({ offset: String(offset), limit: String(limit), q });
    api(`/api/files/${fileId}/items?${qs}`).then(setData).catch(() => {});
  }, [fileId, offset, q]);
  useEffect(load, [load]);
  if (!data) return null;
  const fields = data.kind === 'norms' ? ['hours'] : ['qty', 'norm_h_per_unit', 'unit_labour', 'unit_material'];

  async function edit(item: any) {
    const ov: Record<string, number> = {};
    for (const k of fields) {
      const v = prompt(`${k} (blank = keep)`, String(item.effective?.[k] ?? ''));
      if (v !== null && v.trim() !== '' && Number(v) !== Number(item.effective?.[k])) ov[k] = Number(v);
    }
    if (!Object.keys(ov).length) return;
    await api(`/api/files/${fileId}/items/${item.id}`, { method: 'PATCH', json: { override: ov } }).catch((e) => alert(e.message));
    load();
  }

  return (
    <>
      <h2>{data.kind === 'norms' ? 'Norms' : 'Price items'} ({data.total})</h2>
      <p>
        <label>Search <input value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} /></label>{' '}
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Prev</button>{' '}
        <button type="button" disabled={offset + limit >= data.total} onClick={() => setOffset(offset + limit)}>Next</button>
      </p>
      <table>
        <thead>
          <tr>
            <th>Sheet/row</th><th>Item</th><th>Unit</th>
            {fields.map((k) => <th key={k}>{k}</th>)}
            <th />
          </tr>
        </thead>
        <tbody>
          {data.items.map((it: any) => (
            <tr key={it.id}>
              <td>{it.sheet_name}{it.row_idx ? `!${it.row_idx}` : ''}</td>
              <td>{it.effective?.item_text ?? it.item_text} {it.edited && <em>(Edited)</em>}</td>
              <td>{it.effective?.unit ?? it.unit}</td>
              {fields.map((k) => <td key={k}>{it.effective?.[k] ?? ''}</td>)}
              <td>
                {canEdit && <button type="button" onClick={() => edit(it)}>Edit</button>}{' '}
                {canEdit && it.edited && (
                  <button type="button" onClick={async () => { await api(`/api/files/${fileId}/items/${it.id}`, { method: 'PATCH', json: { reset: true } }); load(); }}>Revert</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function DocxHtml({ fileId }: { fileId: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/files/${fileId}/view/html`, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('json')) {
          const j = await r.json();
          return String(j.html ?? '');
        }
        return r.text();
      })
      .then(setHtml)
      .catch((e) => setErr(String(e.message)));
  }, [fileId]);
  if (err) return <p role="alert">Preview unavailable: {err}</p>;
  if (html === null) return <p>Loading preview…</p>;
  // Rendered in a sandboxed iframe: the worker's mammoth HTML is not trusted markup for this origin.
  return <iframe title="Document preview" sandbox="" srcDoc={html} width="100%" height={600} />;
}
