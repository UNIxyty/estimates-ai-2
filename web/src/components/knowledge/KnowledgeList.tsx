'use client';

/**
 * Knowledge base library (design/knowledge.dc.html, DESIGN.md §4.4): header + Upload files, search, type and
 * status filters, the file table (row → file detail, "Open" → document viewer on the right), empty state.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type CSSProperties } from 'react';
import { MenuButton, useShell } from '@/components/Shell';
import { KindIcon, LangTag, StatusBadge, Spinner } from '@/components/ui';
import { useDocViewer } from '@/components/viewer/useDocViewer';
import { ViewerLayout } from '@/components/viewer/ViewerLayout';
import type { DocRef } from '@/components/viewer/types';
import {
  ACCEPT, extractedLabel, guessTag, isBusy, isUnitRate, packageLabel, shortDate, STATUS_TONE, statusLabel, TAGS, tagLabel, uploadError, uploadFile,
  UnitRateTag, usedLabel, useFiles, viewerSubtitle, type FileRow,
} from './shared';

const GRID = 'minmax(220px,2fr) 190px 60px 84px 110px 150px 84px 70px';
const cell: CSSProperties = { padding: '10px 8px' };
const selectStyle: CSSProperties = { height: 38, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 13.5 };

export function KnowledgeList() {
  const router = useRouter();
  const { mobile } = useShell();
  const viewer = useDocViewer();
  const { files, error, reload } = useFiles();
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [uploading, setUploading] = useState(0);
  const [upErrors, setUpErrors] = useState<string[]>([]);

  const all = files ?? [];
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((f) => (!needle || f.original_name.toLowerCase().includes(needle))
      && (!type || f.tag === type)
      && (!status || (status === 'analysing' ? isBusy(f.status) : f.status === status)));
  }, [all, q, type, status]);

  async function onUpload(list: File[]) {
    if (!list.length) return;
    setUpErrors([]);
    setUploading((n) => n + list.length);
    for (const file of list) {
      try {
        const nf = await uploadFile(file, guessTag(file.name));
        if (nf.duplicate) setUpErrors((es) => [...es, `${file.name}: already in the knowledge base as “${nf.original_name}” (identical file), not added again.`]);
      } catch (e) {
        setUpErrors((es) => [...es, `${file.name}: ${uploadError(e, file)}`]);
      }
      setUploading((n) => n - 1);
      reload();
    }
  }

  const open = (f: FileRow) => viewer.open({ source: 'file', id: f.id, name: f.original_name, language: f.language, subtitle: viewerSubtitle(f.tag) });
  const ask = (d: DocRef) => router.push(`/chat?file=${encodeURIComponent(d.id)}`);
  const empty = files !== null && all.length === 0 && !uploading;

  return (
    <ViewerLayout viewer={viewer} onAsk={ask} railLabel="Library">
      <main style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'auto', background: 'var(--bg)', color: 'var(--ink)' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: mobile ? '16px 16px 48px' : '24px 24px 48px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <MenuButton />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 200 }}>
              <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em' }}>Knowledge base</h1>
              <span style={{ fontSize: 14, color: 'var(--ink2)' }}>Files the agent learns from. Priced estimates teach structure and pricing; norms and price lists fill in the numbers.</span>
            </div>
            <label className="hv-accbg" style={{ height: 40, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '0 16px', borderRadius: 10, background: 'var(--acc)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              {uploading > 0 ? <><Spinner size={13} color="#fff" /> Uploading…</> : '+ Upload files'}
              <input type="file" multiple accept={ACCEPT} onChange={(e) => { onUpload([...(e.target.files ?? [])]); e.target.value = ''; }} style={{ display: 'none' }} />
            </label>
          </div>

          {upErrors.length > 0 && (
            <div role="alert" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, background: 'var(--errSoft)', fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ flex: 1 }}>{upErrors.map((m) => <div key={m}>{m}</div>)}</div>
              <button type="button" onClick={() => setUpErrors([])} aria-label="Dismiss" style={{ border: 0, background: 'transparent', color: 'var(--ink3)', fontSize: 16, cursor: 'pointer' }}>×</button>
            </div>
          )}
          {error && <div role="alert" style={{ fontSize: 13, color: 'var(--err)' }}>Couldn’t load the knowledge base: {error}</div>}

          {files === null && !error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 24, color: 'var(--ink3)', fontSize: 14 }}><Spinner /> Loading files…</div>
          )}

          {empty && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '64px 24px', border: '1.5px dashed var(--line)', borderRadius: 16, background: 'var(--panel)', textAlign: 'center' }}>
              <div style={{ fontSize: 17, fontWeight: 600 }}>No files yet</div>
              <div style={{ maxWidth: 440, fontSize: 14, color: 'var(--ink2)', lineHeight: 1.55 }}>Upload at least one estimate you&apos;ve already priced. Until then, chat is locked because the agent has nothing to learn from.</div>
              <Link href="/setup" style={{ height: 40, display: 'inline-flex', alignItems: 'center', padding: '0 18px', borderRadius: 10, background: 'var(--acc)', color: '#fff', textDecoration: 'none', fontWeight: 600, fontSize: 14 }}>Start setup</Link>
            </div>
          )}

          {files !== null && !empty && (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220, display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)' }}>
                  <span style={{ color: 'var(--ink3)', fontSize: 13 }}>Search</span>
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="File name" aria-label="Search files"
                    style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--ink)', font: 'inherit', fontSize: 14 }} />
                </div>
                <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type" style={{ ...selectStyle, flex: mobile ? 1 : undefined }}>
                  <option value="">All types</option>
                  {TAGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" style={{ ...selectStyle, flex: mobile ? 1 : undefined }}>
                  <option value="">All statuses</option>
                  <option value="analysed">Analysed</option>
                  <option value="analysing">Analysing</option>
                  <option value="failed">Failed</option>
                </select>
              </div>
              <div style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', overflowX: 'auto' }}>
                <div style={{ minWidth: 880 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: GRID, padding: '0 8px', borderBottom: '1px solid var(--line)', fontSize: 12, fontWeight: 600, color: 'var(--ink2)' }}>
                    <div style={cell}>Name</div><div style={cell}>Type</div><div style={cell}>Lang.</div><div style={cell}>Added</div><div style={cell}>Status</div><div style={cell}>Extracted</div><div style={cell}>Used in</div><div />
                  </div>
                  {rows.map((f, i) => (
                    <Link key={f.id} href={`/knowledge/${f.id}`} className="hv-side"
                      style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', padding: '0 8px', borderBottom: i === rows.length - 1 ? 0 : '1px solid var(--line2)', textDecoration: 'none', color: 'var(--ink)', fontSize: 13.5 }}>
                      <div style={{ ...cell, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                        <KindIcon name={f.original_name} />
                        {isUnitRate(f) ? (
                          <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                            <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.original_name}>{f.original_name}</span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                              <UnitRateTag market={f.market} />
                              {(f.project || f.package) && (
                                <span style={{ fontSize: 12, color: 'var(--ink3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {[f.package ? packageLabel(f.package) : null, f.project].filter(Boolean).join(' · ')}
                                </span>
                              )}
                            </span>
                          </span>
                        ) : (
                          <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.original_name}>{f.original_name}</span>
                        )}
                      </div>
                      <div style={{ ...cell, color: 'var(--ink2)' }}>{tagLabel(f.tag)}</div>
                      <div style={cell}>{f.language ? <LangTag lang={f.language} /> : <span style={{ color: 'var(--ink3)' }}>—</span>}</div>
                      <div style={{ ...cell, color: 'var(--ink2)' }}>{shortDate(f.created_at)}</div>
                      <div style={cell}>
                        <StatusBadge label={f.status === 'analysing' ? `Analysing · ${f.progress}%` : statusLabel(f.status)} tone={STATUS_TONE[f.status]} />
                      </div>
                      <div style={{ ...cell, color: 'var(--ink2)', fontSize: 12.5, ...(isUnitRate(f) && f.status === 'analysed' ? { lineHeight: 1.4 } : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) }} title={f.status === 'failed' ? f.fail_reason ?? undefined : undefined}>{extractedLabel(f)}</div>
                      <div style={{ ...cell, color: 'var(--ink2)', fontSize: 12.5 }}>{usedLabel(f)}</div>
                      <div style={{ ...cell, display: 'flex', justifyContent: 'flex-end' }}>
                        <button type="button" className="hv-sunk" onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(f); }}
                          style={{ height: 28, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}>Open</button>
                      </div>
                    </Link>
                  ))}
                  {rows.length === 0 && <div style={{ padding: 28, textAlign: 'center', color: 'var(--ink3)', fontSize: 14 }}>No files match these filters.</div>}
                </div>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--ink3)' }}>{rows.length} of {all.length} files</div>
            </>
          )}
        </div>
      </main>
    </ViewerLayout>
  );
}
