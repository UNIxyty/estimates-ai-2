'use client';

import Link from 'next/link';
import { fmtBytes, fmtInt, fmtUsd, LangTag } from '@/components/ui';
import { LANG_NAME, shortDate, statusLabel, tagLabel } from '../shared';
import type { Detail } from './types';

function whenAnalysed(v: string | null | undefined) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return `${date}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function OverviewTab({ d }: { d: Detail }) {
  const f = d.file;
  const rows = d.sheets.reduce((a, s) => a + (s.row_count || 0), 0);
  const size = [fmtBytes(f.size_bytes), d.sheets.length ? `${d.sheets.length} sheet${d.sheets.length === 1 ? '' : 's'}` : null, rows ? `${fmtInt(rows)} rows` : null].filter(Boolean).join(' · ');
  const status = f.status === 'analysed' ? `Analysed ${whenAnalysed(f.analysed_at) ?? ''}`.trim()
    : f.status === 'analysing' ? `Analysing · ${f.progress}%` : statusLabel(f.status);
  const a = d.analysis;
  const tier = a?.tier ? a.tier[0].toUpperCase() + a.tier.slice(1) : null;
  const cost = a && a.cost_usd > 0 && a.cost_usd < 0.01 ? '<$0.01' : fmtUsd(a?.cost_usd ?? 0);
  const model = !a || a.calls === 0 ? 'No model calls · $0.00' : `${tier ?? 'Embeddings only'} · ${cost}`;
  const lang = f.language ? LANG_NAME[f.language.toUpperCase()] ?? f.language : '—';
  const facts: [string, string][] = [
    ['Type', tagLabel(f.tag)], ['Language', lang], ['Status', status],
    ['Uploaded by', f.uploaded_by_name || '—'], ['Size', size], ['Model used', model],
  ];
  const u = d.usedIn;
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 1, border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden', background: 'var(--line)' }}>
        {facts.map(([k, v]) => (
          <div key={k} style={{ padding: '14px 16px', background: 'var(--panel)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 12, color: 'var(--ink3)' }}>{k}</span>
            <span style={{ fontSize: 14 }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{u.total ? `Used in ${fmtInt(u.total)} estimate${u.total === 1 ? '' : 's'}` : 'Not used in any estimate yet'}</div>
        {u.total > 0 && (
          <div style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', overflow: 'hidden' }}>
            {u.mine.map((m, i) => (
              <Link key={m.conversation_id} href={`/chat/${m.conversation_id}`} className="hv-side"
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: i === u.mine.length - 1 && !u.others ? 0 : '1px solid var(--line2)', textDecoration: 'none', color: 'var(--ink)', fontSize: 14 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</span>
                <LangTag lang={m.language} />
                <span style={{ fontSize: 12.5, color: 'var(--ink3)', minWidth: 60, textAlign: 'right' }}>{shortDate(m.last_used)}</span>
              </Link>
            ))}
            {u.others > 0 && (
              <div style={{ padding: '11px 16px', fontSize: 13.5, color: 'var(--ink3)' }}>
                {u.mine.length ? 'And ' : ''}{fmtInt(u.others)} estimate{u.others === 1 ? '' : 's'} by other people
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
