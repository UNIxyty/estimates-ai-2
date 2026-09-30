'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DesignPending } from '@/components/DesignPending';
import { api, usd, when } from '@/lib/client';

export default function HistoryPage() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[] | null>(null);
  const load = useCallback(() => {
    api<{ conversations: any[] }>(`/api/conversations?q=${encodeURIComponent(q)}`).then((r) => setRows(r.conversations)).catch(() => {});
  }, [q]);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  async function rename(id: string, title: string) {
    const t = prompt('New title', title);
    if (!t) return;
    await api(`/api/conversations/${id}`, { method: 'PATCH', json: { title: t } }).catch((e) => alert(e.message));
    load();
  }
  async function remove(id: string) {
    if (!confirm('Delete this conversation and its documents?')) return;
    await api(`/api/conversations/${id}`, { method: 'DELETE' }).catch((e) => alert(e.message));
    load();
  }

  return (
    <section>
      <DesignPending />
      <h1>History</h1>
      <p><label>Search <input type="search" value={q} onChange={(e) => setQ(e.target.value)} /></label></p>
      {!rows ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>No conversations.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Title</th><th>Last activity</th><th>Messages</th><th>Cost</th><th>Last run</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td><Link href={`/chat/${c.id}`}>{c.title}</Link></td>
                <td>{when(c.last_activity_at)}</td>
                <td>{c.messages}</td>
                <td>{usd(c.cost_usd, 4)}</td>
                <td>{c.last_run_status || '—'}</td>
                <td>
                  <button type="button" onClick={() => rename(c.id, c.title)}>Rename</button>{' '}
                  <button type="button" onClick={() => remove(c.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
