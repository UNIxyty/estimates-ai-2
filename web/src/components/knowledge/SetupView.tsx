'use client';

/**
 * First-run setup (design/setup.dc.html, DESIGN.md §4.3): four-step checklist + lock notice on the left;
 * drag-and-drop upload with live per-file statuses (step 1–2) or "what the agent learned" cards (step 3).
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { api } from '@/lib/client';
import { useUser } from '@/components/UserContext';
import { useShell } from '@/components/Shell';
import { fmtBytes, fmtInt, KindIcon, LangTag } from '@/components/ui';
import { DeleteFileModal } from './DeleteFileModal';
import { Brand } from '@/components/Brand';
import {
  ACCEPT, extractedLabel, guessTag, isBusy, isUnitRate, STATUS_FG, statusLabel, TAGS, tagLabel, UnitRateTag, uploadError, uploadFile, useFiles,
  type FileRow, type FileTag,
} from './shared';

interface Pending { key: string; file: File; tag: FileTag; state: 'uploading' | 'failed'; reason?: string }

const STEPS: [string, string][] = [
  ['Upload priced estimates', 'Required · at least one'],
  ['Add norms and price lists', 'Optional'],
  ['Review what the agent learned', 'Check and correct'],
  ['Start estimating', ''],
];

const selectStyle: CSSProperties = { height: 32, padding: '0 8px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 13, maxWidth: 220 };

export function SetupView() {
  const user = useUser();
  const router = useRouter();
  const { mobile } = useShell();
  const { files, error, reload } = useFiles();
  const [pending, setPending] = useState<Pending[]>([]);
  const [step, setStep] = useState(0);
  const [drag, setDrag] = useState(false);
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [del, setDel] = useState<FileRow | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const seq = useRef(0);

  useEffect(() => {
    api<{ chatUnlocked: boolean }>('/api/knowledge/status').then((s) => setUnlocked(s.chatUnlocked)).catch(() => {});
  }, [files]);

  const canEdit = useCallback((f: FileRow) => user.role === 'admin' || f.uploaded_by === user.id, [user]);

  const rows = useMemo(() => [...(files ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)), [files]);
  const refOk = !!unlocked;
  const hasRef = rows.some((f) => f.tag === 'reference_estimate') || pending.some((p) => p.tag === 'reference_estimate' && p.state === 'uploading');
  const done = [hasRef, step > 1, step > 2 && refOk];

  async function send(p: Pending) {
    try {
      await uploadFile(p.file, p.tag);
      setPending((ps) => ps.filter((x) => x.key !== p.key));
      reload();
    } catch (e) {
      setPending((ps) => ps.map((x) => (x.key === p.key ? { ...x, state: 'failed', reason: uploadError(e, p.file) } : x)));
    }
  }

  function add(list: File[]) {
    if (!list.length) return;
    const fallback: FileTag = step === 1 ? 'price_list' : 'reference_estimate';
    const items: Pending[] = list.map((file) => ({ key: `p${++seq.current}`, file, tag: guessTag(file.name, fallback), state: 'uploading' }));
    setPending((ps) => [...ps, ...items]);
    // One at a time keeps the order and the server's per-file work predictable.
    (async () => { for (const p of items) await send(p); })();
  }

  async function setTag(f: FileRow, tag: string) {
    setRowError((r) => ({ ...r, [f.id]: '' }));
    try {
      await api(`/api/files/${f.id}`, { method: 'PATCH', json: { tag } });
      // A finished analysis was done for the old type: read the file again as the new type.
      if (f.status === 'analysed' || f.status === 'failed') await api(`/api/files/${f.id}/reanalyse`, { method: 'POST' });
    } catch (e) {
      setRowError((r) => ({ ...r, [f.id]: e instanceof Error ? e.message : String(e) }));
    }
    reload();
  }

  async function retry(f: FileRow) {
    setRowError((r) => ({ ...r, [f.id]: '' }));
    try {
      await api(`/api/files/${f.id}/reanalyse`, { method: 'POST' });
    } catch (e) {
      setRowError((r) => ({ ...r, [f.id]: e instanceof Error ? e.message : String(e) }));
    }
    reload();
  }

  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); add([...e.dataTransfer.files]); };
  const hasFiles = rows.length + pending.length > 0;
  const learned = rows.filter((f) => f.status === 'analysed');

  return (
    <main style={{ flex: 1, minWidth: 0, overflow: 'auto', background: 'var(--bg)', color: 'var(--ink)' }}>
      <header style={{ height: 60, flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: mobile ? '0 16px' : '0 24px', borderBottom: '1px solid var(--line)', background: 'var(--panel)' }}>
        <Link href="/chat" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'var(--ink)' }}>
          <Brand variant="topbar" />
        </Link>
        <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--ink3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>Signed in as {user.email}</span>
      </header>
      <div style={{ width: '100%', maxWidth: 1080, margin: '0 auto', padding: mobile ? '24px 16px 48px' : '32px 24px 48px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 32, alignItems: 'start' }}>
        <aside style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 340 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em' }}>Set up your knowledge base</h1>
            <div style={{ fontSize: 14, color: 'var(--ink2)', lineHeight: 1.55 }}>The agent learns how you price by reading estimates you&apos;ve already priced by hand. This takes a few minutes, once.</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', overflow: 'hidden' }}>
            {STEPS.map(([label, note0], i) => {
              const on = i === step, ok = done[i];
              const note = i === 3 ? (refOk ? 'Ready' : 'Unlocks after step 1') : note0;
              return (
                <button key={label} type="button" aria-current={on ? 'step' : undefined}
                  onClick={() => { if (i === 3) { if (refOk) router.push('/chat'); return; } setStep(i); }}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 16px', border: 0, borderBottom: i < 3 ? '1px solid var(--line2)' : 0, background: on ? 'var(--accSoft)' : 'var(--panel)', color: 'var(--ink)', font: 'inherit', textAlign: 'left', cursor: i === 3 && !refOk ? 'default' : 'pointer' }}>
                  <span style={{ width: 24, height: 24, flex: 'none', borderRadius: '50%', border: `1.5px solid ${on ? 'var(--acc)' : ok ? 'var(--ok)' : 'var(--line)'}`, background: ok && !on ? 'var(--ok)' : on ? 'var(--acc)' : 'transparent', color: ok || on ? '#fff' : 'var(--ink3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600 }}>
                    {ok && !on ? '✓' : String(i + 1)}
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: on ? 600 : 500 }}>{label}</span>
                    <span style={{ fontSize: 12.5, color: 'var(--ink3)' }}>{note}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {unlocked !== null && (
            <div role="status" style={{ display: 'flex', gap: 10, padding: '14px 16px', borderRadius: 12, background: refOk ? 'var(--okSoft)' : 'var(--sunk)', fontSize: 13, lineHeight: 1.5, color: 'var(--ink2)' }}>
              <span style={{ flex: 'none', fontWeight: 700, color: refOk ? 'var(--ok)' : 'var(--ink3)' }}>{refOk ? '✓' : '●'}</span>
              <span>{refOk
                ? 'Chat is unlocked. You can start now; files still being analysed will be used when they finish.'
                : 'Chat is locked until at least one priced estimate is analysed. The agent needs an example of how you price.'}</span>
            </div>
          )}
        </aside>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
          {step < 2 && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{step === 0 ? 'Upload estimates you have already priced' : 'Add hourly norms and price lists'}</h2>
                <div style={{ fontSize: 14, color: 'var(--ink2)' }}>{step === 0
                  ? 'Finished, priced estimates teach the agent your structure, rates and markups. Three or more gives the best results.'
                  : 'Optional. Norms and price lists make pricing more accurate. Tag each file so the agent knows how to read it.'}</div>
              </div>
              <label onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: hasFiles ? '24px' : '56px 24px', border: `1.5px dashed ${drag ? 'var(--acc)' : 'var(--line)'}`, borderRadius: 16, background: drag ? 'var(--accSoft)' : 'var(--panel)', textAlign: 'center', cursor: 'pointer' }}>
                <span style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--accSoft)', color: 'var(--accInk)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>+</span>
                <span style={{ fontSize: 15, fontWeight: 600 }}>Drop files here, or click to choose</span>
                <span style={{ fontSize: 13, color: 'var(--ink3)' }}>.xlsx, .xls, .docx or .pdf · up to 50 MB each</span>
                <input type="file" multiple accept={ACCEPT} onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ''; }} style={{ display: 'none' }} />
              </label>
              {error && <div role="alert" style={{ fontSize: 13, color: 'var(--err)' }}>Couldn’t load your files: {error}</div>}
              {hasFiles && (
                <div style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', overflow: 'hidden' }}>
                  {rows.map((f, i) => (
                    <FileLine key={f.id} name={f.original_name} size={fmtBytes(f.size_bytes)} tag={f.tag} status={f.status} progress={f.progress}
                      reason={rowError[f.id] || (f.status === 'failed' ? f.fail_reason || 'The file couldn’t be analysed.' : null)}
                      failed={f.status === 'failed' || !!rowError[f.id]} editable={canEdit(f)} last={i === rows.length - 1 && !pending.length}
                      onTag={(t) => setTag(f, t)} onRetry={() => retry(f)} onRemove={() => setDel(f)} href={`/knowledge/${f.id}`} />
                  ))}
                  {pending.map((p, i) => (
                    <FileLine key={p.key} name={p.file.name} size={fmtBytes(p.file.size)} tag={p.tag} status={p.state === 'failed' ? 'failed' : 'uploading'} progress={0}
                      reason={p.reason ?? null} failed={p.state === 'failed'} editable last={i === pending.length - 1}
                      onTag={(t) => setPending((ps) => ps.map((x) => (x.key === p.key ? { ...x, tag: t as FileTag } : x)))}
                      onRetry={() => { const q = { ...p, state: 'uploading' as const, reason: undefined }; setPending((ps) => ps.map((x) => (x.key === p.key ? q : x))); send(q); }}
                      onRemove={p.state === 'failed' ? () => setPending((ps) => ps.filter((x) => x.key !== p.key)) : undefined} />
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                {step === 1 && <button type="button" onClick={() => setStep(2)} className="hv-sunk" style={{ height: 40, padding: '0 16px', border: 0, borderRadius: 10, background: 'transparent', color: 'var(--ink2)', font: 'inherit', fontSize: 14, cursor: 'pointer' }}>Skip this step</button>}
                <button type="button" disabled={step === 0 && !done[0]} onClick={() => setStep(step + 1)}
                  title={step === 0 && !done[0] ? 'Upload at least one priced estimate first' : undefined}
                  style={{ height: 40, padding: '0 18px', border: 0, borderRadius: 10, background: step === 0 && !done[0] ? 'var(--ink3)' : 'var(--acc)', color: '#fff', font: 'inherit', fontSize: 14, fontWeight: 600, cursor: step === 0 && !done[0] ? 'default' : 'pointer' }}>Continue</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Review what the agent learned</h2>
                <div style={{ fontSize: 14, color: 'var(--ink2)' }}>Check each file. You can correct numbers and notes now or later in the knowledge base.</div>
              </div>
              {learned.length === 0 && (
                <div style={{ padding: '28px 24px', border: '1.5px dashed var(--line)', borderRadius: 14, background: 'var(--panel)', textAlign: 'center', fontSize: 14, color: 'var(--ink2)', lineHeight: 1.55 }}>
                  {rows.some((f) => isBusy(f.status)) ? 'The agent is still reading your files. Each one appears here when its analysis finishes.' : 'No files have been analysed yet. Go back to step 1 and upload a priced estimate.'}
                </div>
              )}
              {learned.map((f) => <LearnedCard key={f.id} f={f} />)}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Link href="/chat" style={{ height: 44, display: 'inline-flex', alignItems: 'center', padding: '0 22px', borderRadius: 10, background: refOk ? 'var(--acc)' : 'var(--ink3)', color: '#fff', textDecoration: 'none', fontSize: 15, fontWeight: 600, pointerEvents: refOk ? undefined : 'none' }} aria-disabled={!refOk}>Start estimating</Link>
              </div>
            </>
          )}
        </section>
      </div>
      <DeleteFileModal file={del} onClose={() => setDel(null)} onDeleted={() => { setDel(null); reload(); }} />
    </main>
  );
}

function FileLine({ name, size, tag, status, progress, reason, failed, editable, last, onTag, onRetry, onRemove, href }: {
  name: string; size: string; tag: string; status: string; progress: number; reason: string | null; failed: boolean; editable: boolean; last: boolean;
  onTag: (t: string) => void; onRetry: () => void; onRemove?: () => void; href?: string;
}) {
  const busy = isBusy(status) || status === 'uploading';
  const label = status === 'uploading' ? 'Uploading' : status === 'analysing' ? `Analysing · ${progress}%` : statusLabel(status);
  const pct = status === 'uploading' || status === 'queued' ? 0 : Math.max(progress, status === 'reading' ? 8 : 0);
  const color = status === 'uploading' ? 'var(--ink3)' : STATUS_FG[status] ?? 'var(--ink3)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 16px', borderBottom: last ? 0 : '1px solid var(--line2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <KindIcon name={name} w={30} h={34} fontSize={8.5} />
        <span style={{ flex: 1, minWidth: 140, display: 'flex', flexDirection: 'column' }}>
          {href && status === 'analysed'
            ? <Link href={href} className="hv-under" style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink)', textDecoration: 'none', overflowWrap: 'anywhere' }}>{name}</Link>
            : <span style={{ fontSize: 14, fontWeight: 500, overflowWrap: 'anywhere' }}>{name}</span>}
          <span style={{ fontSize: 12, color: 'var(--ink3)' }}>{size}</span>
        </span>
        <select aria-label={`Type of ${name}`} value={tag} disabled={!editable || status === 'uploading'} onChange={(e) => onTag(e.target.value)} style={selectStyle}>
          {TAGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span style={{ minWidth: 112, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 500, color }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'currentColor' }} />{label}
        </span>
        {editable && onRemove
          ? <button type="button" onClick={onRemove} title="Remove" aria-label={`Remove ${name}`} className="hv-sunk" style={{ width: 28, height: 28, border: 0, borderRadius: 7, background: 'transparent', color: 'var(--ink3)', fontSize: 16, cursor: 'pointer' }}>×</button>
          : <span style={{ width: 28 }} />}
      </div>
      {busy && !failed && (
        <div style={{ height: 4, borderRadius: 2, background: 'var(--sunk)', overflow: 'hidden', marginLeft: 42 }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--acc)', transition: 'width .6s' }} />
        </div>
      )}
      {failed && reason && (
        <div style={{ marginLeft: 42, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', borderRadius: 10, background: 'var(--errSoft)', fontSize: 13 }}>
          <span style={{ flex: 1, minWidth: 200, color: 'var(--ink)' }}>{reason}</span>
          {editable && <button type="button" onClick={onRetry} style={{ height: 30, padding: '0 12px', border: '1px solid var(--err)', borderRadius: 8, background: 'var(--panel)', color: 'var(--err)', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Retry</button>}
        </div>
      )}
    </div>
  );
}

function LearnedCard({ f }: { f: FileRow }) {
  const s = f.summary ?? {};
  const sheets = (s.sheets ?? []).filter((x) => x.rows > 0);
  const names = sheets.map((x) => x.name.trim());
  const c = f.counts;
  const structure = sheets.length
    ? `${sheets.length} sheet${sheets.length === 1 ? '' : 's'}${names.length <= 4 ? ` (${names.join(', ')})` : ''} · ${fmtInt(c?.sections ?? s.sections ?? 0)} sections`
    : (s.description || '—');
  const rates = [...new Set(s.hourly_rates ?? [])];
  const cur = s.currency || '';
  const unit = isUnitRate(f);
  const logic = unit ? 'Quantity × unit rate (no hours)' : f.tag === 'hourly_norms'
    ? 'Hours per unit'
    : rates.length
      ? `Norm × ${rates.map((r) => `${cur} ${fmtRate(r)}/h`.trim()).join(', ')}`
      : f.tag === 'price_list' ? 'Unit prices' : 'No hourly rate found';
  const saved: string[] = [];
  if (c && unit) {
    saved.push(extractedLabel(f), `${fmtInt(c.notes)} note${c.notes === 1 ? '' : 's'}`);
  } else if (c) {
    if (c.price_items) saved.push(`${fmtInt(c.price_items)} price${c.price_items === 1 ? '' : 's'}`);
    const norms = c.norms + c.price_norms;
    if (norms) saved.push(`${fmtInt(norms)} norm${norms === 1 ? '' : 's'}`);
    saved.push(`${fmtInt(c.notes)} note${c.notes === 1 ? '' : 's'}`);
  }
  const cell: CSSProperties = { padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 3, borderRight: '1px solid var(--line2)' };
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--line2)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{f.original_name}</span>
        <LangTag lang={f.language} />
        <span style={{ fontSize: 12.5, color: 'var(--ink3)' }}>{tagLabel(f.tag)}</span>
        {unit && <UnitRateTag market={f.market} />}
        <Link href={`/knowledge/${f.id}`} style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 500 }}>Review details ›</Link>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
        <div style={cell}><span style={{ fontSize: 12, color: 'var(--ink3)' }}>Structure</span><span style={{ fontSize: 13.5 }}>{structure}</span></div>
        <div style={cell}><span style={{ fontSize: 12, color: 'var(--ink3)' }}>Calculation logic</span><span style={{ fontSize: 13.5 }}>{logic}</span></div>
        <div style={{ ...cell, borderRight: 0 }}><span style={{ fontSize: 12, color: 'var(--ink3)' }}>Saved</span><span style={{ fontSize: 13.5 }}>{saved.join(' · ') || '—'}</span></div>
      </div>
    </div>
  );
}

function fmtRate(r: number) {
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}
