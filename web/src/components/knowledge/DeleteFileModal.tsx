'use client';

/** "Delete <file>?" confirmation (design/knowledge-file.dc.html): says what the agent will forget. */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { fmtInt, Modal, Spinner } from '@/components/ui';

interface Preview { price_items: number; norms: number; notes: number; logic: number; sheets: number; embeddings: number; used_in: number }

const plural = (n: number, one: string, many = one + 's') => `${fmtInt(n)} ${n === 1 ? one : many}`;

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function forgetSentence(p: Preview): string {
  const nums = p.price_items + p.norms;
  const parts: string[] = [];
  if (nums) parts.push(`the ${plural(nums, 'price or norm', 'prices and norms')}`);
  if (p.logic) parts.push(plural(p.logic, 'calculation rule'));
  if (p.notes) parts.push(plural(p.notes, 'note'));
  const what = parts.length ? `${joinList(parts)} it learned from this file` : 'everything it learned from this file';
  const used = p.used_in ? ` It was used in ${plural(p.used_in, 'estimate')}; those` : ' Estimates you’ve already made';
  return `The agent will forget ${what}.${used} won’t change.`;
}

export function DeleteFileModal({ file, onClose, onDeleted }: { file: { id: string; original_name: string } | null; onClose: () => void; onDeleted: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setError(null);
    if (!file) return;
    api<Preview>(`/api/files/${file.id}/forget-preview`).then(setPreview).catch((e) => setError(e.message));
  }, [file]);

  async function del() {
    if (!file) return;
    setBusy(true);
    try {
      await api(`/api/files/${file.id}`, { method: 'DELETE' });
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  return (
    <Modal open={!!file} onClose={onClose} width={420} label="Delete file">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, }}>
        <div style={{ fontSize: 17, fontWeight: 600, overflowWrap: 'anywhere' }}>Delete {file?.original_name}?</div>
        <div style={{ fontSize: 14, color: 'var(--ink2)', lineHeight: 1.55 }}>
          {preview ? forgetSentence(preview) : error ? null : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Spinner size={12} /> Checking what the agent learned from this file…</span>}
        </div>
        {error && <div role="alert" style={{ fontSize: 13, color: 'var(--err)' }}>{error === 'forbidden' ? 'Only the person who uploaded this file or an admin can delete it.' : error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button type="button" onClick={onClose} className="hv-sunk" style={{ height: 38, padding: '0 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 14, cursor: 'pointer' }}>Cancel</button>
          <button type="button" onClick={del} disabled={busy || !preview}
            style={{ height: 38, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '0 14px', border: 0, borderRadius: 10, background: 'var(--err)', color: '#fff', font: 'inherit', fontWeight: 600, fontSize: 14, cursor: busy || !preview ? 'default' : 'pointer', opacity: busy || !preview ? 0.7 : 1 }}>
            {busy && <Spinner size={12} color="#fff" />}Delete file
          </button>
        </div>
      </div>
    </Modal>
  );
}
