'use client';

/**
 * design/chat-new.dc.html (DESIGN.md §4.6): greeting, composer, two suggestion cards, three example prompts and
 * the knowledge-base status line; locked until the first reference estimate is analysed (GET /api/knowledge/status).
 * Sending creates the conversation, posts the message and opens /chat/{id}.
 */
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { MenuButton, useShell } from '@/components/Shell';
import { useUser } from '@/components/UserContext';
import { MONO } from '@/components/ui';
import { ViewerLayout } from '@/components/viewer/ViewerLayout';
import { useDocViewer } from '@/components/viewer/useDocViewer';
import { Composer, loadPicker, type ComposerChip, type ComposerHandle } from './Composer';
import { postChatMessage, sendErrorText } from './send';
import type { FileRef } from './types';
import s from './Chat.module.css';

interface KStatus { chatUnlocked: boolean; counts: { total: number; byStatus: Record<string, number> } }

function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function NewChat() {
  const router = useRouter();
  const search = useSearchParams();
  const fileParam = search.get('file');
  const user = useUser();
  const { mobile, refreshConversations } = useShell();
  const viewer = useDocViewer();
  const composer = useRef<ComposerHandle>(null);
  const [status, setStatus] = useState<KStatus | null>(null);
  const [refs, setRefs] = useState<FileRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hello, setHello] = useState('Hello');

  useEffect(() => {
    setHello(greeting());
    api<KStatus>('/api/knowledge/status').then(setStatus).catch(() => {});
    loadPicker(true).then((gs) => setRefs(gs.flatMap((g) => g.files).filter((f) => (f.status ?? 'analysed') === 'analysed')));
  }, []);

  // "Ask about this document" on a knowledge file opens /chat?file=<id>: start with that file as a reference.
  const locked0 = status ? !status.chatUnlocked : true;
  useEffect(() => {
    if (!fileParam || locked0) return;
    let alive = true;
    api<{ file: FileRef & { status: string } }>(`/api/files/${encodeURIComponent(fileParam)}`)
      .then(({ file: f }) => {
        if (!alive) return;
        if (f.status !== 'analysed') { setError(`${f.original_name} is not analysed yet, so it can't be a reference.`); return; }
        composer.current?.addChip({ key: `file:${f.id}`, source: 'file', id: f.id, name: f.original_name, role: 'Reference', language: f.language });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [fileParam, locked0]);

  const first = (user.name || '').trim().split(/\s+/)[0] || user.email.split('@')[0];
  const locked = status ? !status.chatUnlocked : false;
  const total = status?.counts.total ?? 0;
  const analysed = status?.counts.byStatus?.analysed ?? 0;

  async function send(text: string, chips: ComposerChip[]) {
    setError(null);
    try {
      const c = await api<{ conversation: { id: string } }>('/api/conversations', { method: 'POST', json: {} });
      try {
        await postChatMessage(c.conversation.id, text, chips);
      } catch (e) {
        // Don't leave an empty conversation behind when the message was refused.
        await api(`/api/conversations/${c.conversation.id}`, { method: 'DELETE' }).catch(() => {});
        throw e;
      }
      refreshConversations();
      router.push(`/chat/${c.conversation.id}`);
      return true;
    } catch (e) {
      setError(sendErrorText(e));
      return false;
    }
  }

  const estimates = refs.filter((f) => f.tag === 'reference_estimate').slice(0, 2);
  const examples: { text: string; chips?: FileRef[] }[] = [
    estimates.length
      ? { text: `Fill the attached blank using ${estimates.map((f) => f.original_name).join(' and ')}`, chips: estimates }
      : { text: 'Fill the attached blank using my references' },
    { text: '80 sockets, 40 switches, 1 distribution board 36 modules, 600 m cable 3x1.5' },
    { text: 'Price an office job, about 400 m²' },
  ];
  const applyExample = (e: (typeof examples)[number]) => {
    composer.current?.setText(e.text);
    for (const f of e.chips || [])
      composer.current?.addChip({ key: `file:${f.id}`, source: 'file', id: f.id, name: f.original_name, role: 'Reference', language: f.language });
    if (e.chips?.length) composer.current?.attach();
  };

  const card: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, padding: 18, border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', color: 'var(--ink)', textAlign: 'left', font: 'inherit', cursor: 'pointer' };
  return (
    <ViewerLayout viewer={viewer} railLabel="Chat">
      <main style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        {mobile && <div style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 6px' }}><MenuButton /></div>}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '32px 20px 48px' }}>
          <div style={{ width: '100%', maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' }}>
              <span style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--acc)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 18, fontWeight: 600 }}>E</span>
              <h1 style={{ margin: '8px 0 0', fontSize: 30, fontWeight: 500, letterSpacing: '-0.02em' }}>{hello}, {first}</h1>
              <div style={{ fontSize: 16, color: 'var(--ink2)' }}>What are we estimating today?</div>
            </div>

            {status && locked && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 20, border: '1px solid var(--line)', borderRadius: 16, background: 'var(--panel)', textAlign: 'center', alignItems: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>Chat opens after your first reference is analysed</div>
                <div style={{ maxWidth: 480, color: 'var(--ink2)', fontSize: 14, lineHeight: 1.55 }}>The agent prices new estimates by learning from ones you already priced. Upload at least one priced estimate so it has something to learn from.</div>
                <Link href="/setup" className="hv-accbg" style={{ height: 40, display: 'inline-flex', alignItems: 'center', padding: '0 18px', borderRadius: 10, background: 'var(--acc)', color: '#fff', textDecoration: 'none', fontWeight: 600, fontSize: 14 }}>Set up the knowledge base</Link>
              </div>
            )}

            {!locked && (
              <>
                <Composer ref={composer} placeholder="Describe the work, attach a blank, or type / to pick references" onSend={send} error={error}
                  onOpenDoc={(d) => viewer.open(d)} disabled={!status} autoFocus={!mobile} />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12 }}>
                  <button type="button" className={s.accBorder} style={card} onClick={() => composer.current?.attach()}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ width: 30, height: 34, borderRadius: 5, background: 'var(--okSoft)', color: 'var(--ok)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 8.5, fontWeight: 600 }}>XLSX</span>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>Fill a blank</span>
                    </span>
                    <span style={{ fontSize: 13.5, color: 'var(--ink2)', lineHeight: 1.5 }}>Attach an estimate blank. The agent fills in quantities and prices, in the blank&apos;s own language.</span>
                    <span style={{ fontSize: 13, color: 'var(--accInk)', fontWeight: 500, marginTop: 4 }}>Attach a blank ›</span>
                  </button>
                  <button type="button" className={s.accBorder} style={card} onClick={() => composer.current?.focus()}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ width: 30, height: 34, borderRadius: 5, background: 'var(--accSoft)', color: 'var(--accInk)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 14, fontWeight: 600 }}>≡</span>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>Generate from a work list</span>
                    </span>
                    <span style={{ fontSize: 13.5, color: 'var(--ink2)', lineHeight: 1.5 }}>Type or attach the work needed. The agent builds a new estimate laid out like your references.</span>
                    <span style={{ fontSize: 13, color: 'var(--accInk)', fontWeight: 500, marginTop: 4 }}>Describe the work ›</span>
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--ink3)', padding: '0 10px 4px' }}>Try one of these</div>
                  {examples.map((e) => (
                    <button key={e.text} type="button" className={s.example} onClick={() => applyExample(e)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, border: 0, borderRadius: 10, background: 'transparent', color: 'var(--ink2)', font: 'inherit', fontSize: 14, textAlign: 'left', cursor: 'pointer' }}>
                      <span style={{ color: 'var(--ink3)' }}>›</span>{e.text}
                    </button>
                  ))}
                </div>
                {status && (
                  <div style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--ink3)' }}>
                    Knowledge base: {total} file{total === 1 ? '' : 's'}, {analysed} analysed · <Link href="/knowledge">Manage</Link>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </ViewerLayout>
  );
}
