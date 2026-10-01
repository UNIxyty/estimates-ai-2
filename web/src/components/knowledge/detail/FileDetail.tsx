'use client';

/**
 * Knowledge file detail (design/knowledge-file.dc.html, DESIGN.md §4.5): header with actions, re-analyse
 * progress banner, analysis-failed panel, and five tabs. `?tab=` deep-links a tab.
 */
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError } from '@/lib/client';
import { useUser } from '@/components/UserContext';
import { MenuButton, useShell } from '@/components/Shell';
import { fmtInt, KindIcon, LangTag, Spinner, StatusBadge } from '@/components/ui';
import { useDocViewer } from '@/components/viewer/useDocViewer';
import { ViewerLayout } from '@/components/viewer/ViewerLayout';
import { DeleteFileModal } from '../DeleteFileModal';
import { ACCEPT, isBusy, STATUS_TONE, statusLabel, tagLabel, uploadError, uploadFile, viewerSubtitle } from '../shared';
import type { Detail } from './types';
import { OverviewTab } from './OverviewTab';
import { StructureTab } from './StructureTab';
import { LogicTab } from './LogicTab';
import { NumbersTab } from './NumbersTab';
import { NotesTab } from './NotesTab';

const TABS = [['overview', 'Overview'], ['structure', 'Structure'], ['logic', 'Calculation logic'], ['numbers', 'Saved numbers'], ['notes', 'Agent notes']] as const;
type TabKey = (typeof TABS)[number][0];

const actionBtn: CSSProperties = { height: 38, padding: '0 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 13.5, fontWeight: 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8 };

export function FileDetail({ fileId }: { fileId: string }) {
  const user = useUser();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { mobile } = useShell();
  const viewer = useDocViewer();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);

  const tabParam = search.get('tab');
  const tab: TabKey = (TABS.find((t) => t[0] === tabParam)?.[0] ?? 'overview') as TabKey;
  const setTab = (k: TabKey) => router.replace(`${pathname}${k === 'overview' ? '' : `?tab=${k}`}`, { scroll: false });

  const load = useCallback(async () => {
    try {
      setD(await api<Detail>(`/api/files/${fileId}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'notfound' : e instanceof Error ? e.message : String(e));
    }
  }, [fileId]);
  useEffect(() => { load(); }, [load]);

  const busy = !!d && isBusy(d.file.status);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [busy, load]);

  if (error === 'notfound') {
    return (
      <main style={mainStyle}>
        <div style={{ ...wrap(mobile), alignItems: 'flex-start' }}>
          <MenuButton />
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>File not found</h1>
          <div style={{ fontSize: 14, color: 'var(--ink2)' }}>It may have been deleted.</div>
          <Link href="/knowledge" style={{ fontSize: 14 }}>Back to the knowledge base</Link>
        </div>
      </main>
    );
  }
  if (!d) {
    return (
      <main style={mainStyle}>
        <div style={wrap(mobile)}>
          <MenuButton />
          {error ? <div role="alert" style={{ color: 'var(--err)', fontSize: 14 }}>Couldn’t load this file: {error}</div>
            : <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink3)', fontSize: 14 }}><Spinner /> Loading…</div>}
        </div>
      </main>
    );
  }

  const f = d.file;
  const canEdit = user.role === 'admin' || f.uploaded_by === user.id;
  const failed = f.status === 'failed';
  const noEdit = canEdit ? undefined : 'Only the person who uploaded this file or an admin can change it';
  const savedCount = d.counts.price_items + d.counts.norms;
  const pct = f.progress ?? 0;
  const again = !!f.analysed_at;
  const runLabel = f.status === 'queued' ? 'Waiting for its turn…'
    : pct < 30 ? (again ? 'Reading the file again…' : 'Reading the file…')
      : pct < 70 ? 'Analysing structure and prices…'
        : again ? 'Comparing with what it learned before…' : 'Saving what it learned…';

  async function reanalyse() {
    setActionError(null);
    try {
      await api(`/api/files/${fileId}/reanalyse`, { method: 'POST' });
    } catch (e) {
      setActionError(e instanceof ApiError && e.status === 409 ? 'This file is already being analysed.' : e instanceof Error ? e.message : String(e));
    }
    load();
  }

  async function replace(file: File | undefined) {
    if (!file) return;
    setActionError(null);
    setReplacing(true);
    try {
      const nf = await uploadFile(file, f.tag);
      await api(`/api/files/${fileId}`, { method: 'DELETE' }).catch(() => {});
      router.replace(`/knowledge/${nf.id}`);
    } catch (e) {
      setActionError(uploadError(e, file));
      setReplacing(false);
    }
  }

  const openDoc = () => viewer.open({ source: 'file', id: f.id, name: f.original_name, language: f.language, subtitle: viewerSubtitle(f.tag) });

  return (
    <ViewerLayout viewer={viewer} onAsk={(doc) => router.push(`/chat?file=${encodeURIComponent(doc.id)}`)} railLabel="File">
      <main style={mainStyle}>
        <div style={wrap(mobile)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink3)', minWidth: 0 }}>
            <MenuButton />
            <Link href="/knowledge" className="hv-under" style={{ color: 'var(--ink2)', textDecoration: 'none', flex: 'none' }}>Knowledge base</Link>
            <span>›</span>
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.original_name}</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ borderRadius: 8, overflow: 'hidden', flex: 'none', display: 'flex' }}><KindIcon name={f.original_name} w={44} h={52} fontSize={10.5} /></span>
            <div style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em', overflowWrap: 'anywhere' }}>{f.original_name}</h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, color: 'var(--ink2)' }}>
                <span>{tagLabel(f.tag)}</span>
                <LangTag lang={f.language} />
                <StatusBadge label={statusLabel(f.status)} tone={STATUS_TONE[f.status]} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={openDoc} className="hv-sunk" style={actionBtn}>Open document</button>
              <button type="button" onClick={reanalyse} disabled={!canEdit || busy} title={noEdit ?? (busy ? 'The file is being analysed' : undefined)} className={canEdit && !busy ? 'hv-sunk' : undefined}
                style={{ ...actionBtn, opacity: !canEdit || busy ? 0.55 : 1, cursor: !canEdit || busy ? 'default' : 'pointer' }}>Re-analyse</button>
              <button type="button" onClick={() => setConfirm(true)} disabled={!canEdit} title={noEdit} className={canEdit ? 'hv-errSoft' : undefined}
                style={{ ...actionBtn, color: 'var(--err)', opacity: canEdit ? 1 : 0.55, cursor: canEdit ? 'pointer' : 'default' }}>Delete</button>
            </div>
          </div>

          {actionError && <div role="alert" style={{ padding: '10px 14px', borderRadius: 12, background: 'var(--errSoft)', fontSize: 13.5 }}>{actionError}</div>}

          {busy && (
            <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12, background: 'var(--accSoft)', fontSize: 13.5 }}>
              <span style={{ width: 16, height: 16, flex: 'none', borderRadius: '50%', border: '2px solid var(--panel)', borderTopColor: 'var(--acc)', animation: 'spin .8s linear infinite', boxSizing: 'border-box' }} />
              <span style={{ flex: 1 }}>{runLabel}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--accInk)' }}>{pct}%</span>
            </div>
          )}

          {failed && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 16, border: '1px solid var(--err)', borderRadius: 14, background: 'var(--errSoft)' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--err)' }}>Analysis failed</div>
              <div style={{ fontSize: 14, lineHeight: 1.55 }}>{failText(f.fail_reason)}</div>
              {canEdit && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" onClick={reanalyse} className="hv-accbg" style={{ height: 36, padding: '0 14px', border: 0, borderRadius: 9, background: 'var(--acc)', color: '#fff', font: 'inherit', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}>Try again</button>
                  <button type="button" onClick={() => replaceInput.current?.click()} disabled={replacing} className="hv-sunk"
                    style={{ height: 36, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '0 14px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 13.5, cursor: 'pointer' }}>
                    {replacing && <Spinner size={12} />}Replace file
                  </button>
                  <input ref={replaceInput} type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={(e) => { replace(e.target.files?.[0]); e.target.value = ''; }} />
                </div>
              )}
            </div>
          )}

          {!failed && (
            <>
              <div role="tablist" style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--line)', overflowX: 'auto' }}>
                {TABS.map(([key, label]) => {
                  const on = tab === key;
                  const count = key === 'numbers' && savedCount ? fmtInt(savedCount) : '';
                  return (
                    <button key={key} type="button" role="tab" aria-selected={on} onClick={() => setTab(key)}
                      ref={on ? (el) => { el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } : undefined}
                      style={{ flex: 'none', height: 40, padding: '0 14px', border: 0, borderBottom: `2px solid ${on ? 'var(--acc)' : 'transparent'}`, marginBottom: -1, background: 'transparent', color: on ? 'var(--ink)' : 'var(--ink2)', font: 'inherit', fontSize: 14, fontWeight: on ? 600 : 400, cursor: 'pointer' }}>
                      {label}{count && <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--ink3)' }}>{count}</span>}
                    </button>
                  );
                })}
              </div>
              {tab === 'overview' && <OverviewTab d={d} />}
              {tab === 'structure' && <StructureTab d={d} />}
              {tab === 'logic' && <LogicTab d={d} canEdit={canEdit} onChanged={load} />}
              {tab === 'numbers' && <NumbersTab d={d} canEdit={canEdit} onChanged={load} />}
              {tab === 'notes' && <NotesTab d={d} canEdit={canEdit} onChanged={load} />}
            </>
          )}
        </div>
      </main>
      <DeleteFileModal file={confirm ? f : null} onClose={() => setConfirm(false)} onDeleted={() => router.push('/knowledge')} />
    </ViewerLayout>
  );
}

const mainStyle: CSSProperties = { flex: 1, minWidth: 0, height: '100%', overflow: 'auto', background: 'var(--bg)', color: 'var(--ink)' };
const wrap = (mobile: boolean): CSSProperties => ({ maxWidth: 960, margin: '0 auto', padding: mobile ? '12px 16px 48px' : '20px 24px 48px', display: 'flex', flexDirection: 'column', gap: 18 });

function failText(reason: string | null) {
  const r = (reason || 'The agent couldn’t read this file.').trim();
  return `${r}${/[.!?]$/.test(r) ? '' : '.'} Nothing from this file is being used.`;
}
