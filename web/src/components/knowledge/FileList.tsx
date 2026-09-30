'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, when } from '@/lib/client';
import { useUser } from '@/components/UserContext';
import { TAG_LABELS } from './UploadKnowledge';

export interface FileRow {
  id: string;
  original_name: string;
  ext: string;
  size_bytes: number;
  tag: string;
  status: string;
  progress: number;
  fail_reason: string | null;
  created_at: string;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
}

/** Polls GET /api/files while anything is still being analysed. */
export function useFiles() {
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api<{ files: FileRow[] }>('/api/files')
      .then((r) => setFiles(r.files))
      .catch((e) => setError(String(e.message)));
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  const busy = (files || []).some((f) => ['queued', 'reading', 'analysing'].includes(f.status));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [busy, reload]);
  return { files, error, reload };
}

export function FileList({ files, onChanged }: { files: FileRow[]; onChanged: () => void }) {
  const user = useUser();
  const [confirm, setConfirm] = useState<{ id: string; name: string; preview: Record<string, number> } | null>(null);

  async function askDelete(f: FileRow) {
    const preview = await api<Record<string, number>>(`/api/files/${f.id}/forget-preview`);
    setConfirm({ id: f.id, name: f.original_name, preview });
  }
  async function doDelete() {
    if (!confirm) return;
    await api(`/api/files/${confirm.id}`, { method: 'DELETE' }).catch((e) => alert(e.message));
    setConfirm(null);
    onChanged();
  }

  if (!files.length) return <p>No knowledge files yet.</p>;
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>File</th><th>Type</th><th>Status</th><th>Uploaded</th><th>By</th><th />
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.id}>
              <td><Link href={`/knowledge/${f.id}`}>{f.original_name}</Link></td>
              <td>{TAG_LABELS[f.tag] || f.tag}</td>
              <td>
                {f.status}
                {['reading', 'analysing', 'queued'].includes(f.status) && (
                  <> <progress max={100} value={f.progress} /> {f.progress}%</>
                )}
                {f.status === 'failed' && f.fail_reason && <> — {f.fail_reason}</>}
              </td>
              <td>{when(f.created_at)}</td>
              <td>{f.uploaded_by_name || '—'}</td>
              <td>
                {(user.role === 'admin' || f.uploaded_by === user.id) && (
                  <button type="button" onClick={() => askDelete(f)}>Delete…</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {confirm && (
        <dialog open>
          <p>Delete <b>{confirm.name}</b>? The agent will forget:</p>
          <ul>
            <li>{confirm.preview.price_items} price items</li>
            <li>{confirm.preview.norms} norms</li>
            <li>{confirm.preview.logic} logic sentences</li>
            <li>{confirm.preview.notes} notes</li>
            <li>{confirm.preview.embeddings} embeddings</li>
            <li>Used in {confirm.preview.used_in} conversation(s) (their documents are kept)</li>
          </ul>
          <button type="button" onClick={doDelete}>Delete and forget</button>{' '}
          <button type="button" onClick={() => setConfirm(null)}>Cancel</button>
        </dialog>
      )}
    </>
  );
}
