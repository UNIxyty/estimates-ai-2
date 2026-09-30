'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/client';

export const TAG_LABELS: Record<string, string> = {
  reference_estimate: 'Reference estimate',
  hourly_norms: 'Hourly norms',
  price_list: 'Price list',
  other: 'Other',
};

export function UploadKnowledge({ defaultTag = 'reference_estimate', onUploaded }: { defaultTag?: string; onUploaded?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const files = fd.getAll('file').filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) return setMsg('Choose at least one file.');
    setBusy(true);
    setMsg(null);
    const errors: string[] = [];
    for (const file of files) {
      const one = new FormData();
      one.set('file', file);
      one.set('tag', String(fd.get('tag')));
      try {
        await api('/api/files', { method: 'POST', body: one });
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof ApiError ? err.message : 'upload failed'}`);
      }
    }
    setBusy(false);
    setMsg(errors.length ? errors.join('; ') : `Uploaded ${files.length} file(s). Analysis runs in the background.`);
    form.reset();
    onUploaded?.();
  }

  return (
    <form onSubmit={submit}>
      <fieldset>
        <legend>Upload knowledge files</legend>
        <p>
          <label>
            Files (.xlsx, .xls, .docx, .pdf — max 50 MB each){' '}
            <input type="file" name="file" multiple accept=".xlsx,.xls,.docx,.pdf" />
          </label>
        </p>
        <p>
          <label>
            Type{' '}
            <select name="tag" defaultValue={defaultTag}>
              {Object.entries(TAG_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
        </p>
        <button type="submit" disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</button>
        {msg && <p role="status">{msg}</p>}
      </fieldset>
    </form>
  );
}
