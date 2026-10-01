'use client';

/**
 * design/chat.dc.html (DESIGN.md §4.7): header (title, language tag, conversation cost), messages column,
 * composer, optional document viewer on the right. Every scenario of the design is a real state here:
 * working steps come from step.* run events, cards from card.* events, "blocked" from GET /api/budget/status.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/client';
import { MenuButton, useShell } from '@/components/Shell';
import { fmtUsd, fmtWhen, LangTag } from '@/components/ui';
import { ViewerLayout } from '@/components/viewer/ViewerLayout';
import { useDocViewer } from '@/components/viewer/useDocViewer';
import type { DocRef } from '@/components/viewer/types';
import { Composer, loadPicker, uploadRole, type ComposerChip, type ComposerHandle } from './Composer';
import { ChatContext, type ChatCtx } from './context';
import { AgentMessage, UserMessage } from './Message';
import { StepsBlock, type StepsStatus } from './Blocks';
import { postChatMessage, sendErrorText } from './send';
import { BLOCKING, TERMINAL, type Card, type ChatMessage, type FileRef, type LiveRun, type Step } from './types';
import { useConversation } from './useConversation';

interface Budget { state: string; action: string; blocked: boolean; fast_only: boolean; spent_usd: number; amount_usd: number; message: string | null }

/** Steps of a run, split by the assistant message they led to (see anchorSteps). */
interface Segment { runId: string; steps: Step[]; status: StepsStatus; startedAt: number; endedAt: number }

/**
 * A step belongs to the first assistant message of its run created after the step started; later steps (no
 * newer message yet) belong to the run's last message, or stand alone while the run has no message.
 */
function anchorSteps(run: LiveRun, runMsgs: ChatMessage[]): { byMessage: Record<string, Segment>; tail: Segment | null } {
  const steps = run.stepOrder.map((id) => run.steps[id]).filter(Boolean);
  const byMessage: Record<string, Segment> = {};
  let tail: Segment | null = null;
  if (!steps.length) return { byMessage, tail };
  const msgs = [...runMsgs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const lastKey = msgs.length ? msgs[msgs.length - 1].id : null;
  const groups = new Map<string | null, Step[]>();
  for (const st of steps) {
    const after = msgs.find((m) => Date.parse(m.created_at) >= st.startedAt - 50);
    const key = after ? after.id : lastKey;
    groups.set(key, [...(groups.get(key) || []), st]);
  }
  const active = !TERMINAL.includes(run.status);
  const lastStatus: StepsStatus = run.status === 'waiting' || run.status === 'paused_cost' ? 'waiting'
    : active ? 'running' : run.status === 'cancelled' ? 'cancelled' : run.status === 'failed' ? 'failed' : 'done';
  const keys = [...groups.keys()];
  for (const [key, list] of groups) {
    const isLast = key === lastKey;
    // The run's own start / finish times bound its first / last segment (steps may be instantaneous).
    const runStart = run.started_at ? Date.parse(run.started_at) : NaN;
    const runEnd = run.finished_at && !active ? Date.parse(run.finished_at) : NaN;
    let startedAt = Math.min(...list.map((x) => x.startedAt));
    let endedAt = Math.max(...list.map((x) => x.endedAt ?? x.startedAt));
    if (key === keys[0] && runStart < startedAt) startedAt = runStart;
    if (isLast && runEnd > endedAt) endedAt = runEnd;
    const seg: Segment = { runId: run.id, steps: list, status: isLast ? lastStatus : 'done', startedAt, endedAt };
    if (key) byMessage[key] = seg;
    else tail = seg;
  }
  return { byMessage, tail };
}

function firstOfNextMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

export function ChatView({ conversationId }: { conversationId: string }) {
  const { mobile, refreshConversations } = useShell();
  const conv = useConversation(conversationId, { onRunEnd: refreshConversations });
  const { messages, cards, docs, runs, uploads, references, convCost, loadError } = conv;
  const viewer = useDocViewer();
  const composer = useRef<ComposerHandle>(null);
  const floatComposer = useRef<ComposerHandle>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [pickerFiles, setPickerFiles] = useState<Record<string, FileRef>>({});
  const [sendError, setSendError] = useState<string | null>(null);
  const [floatSentAt, setFloatSentAt] = useState<string | null>(null);

  useEffect(() => {
    api<Budget>('/api/budget/status').then(setBudget).catch(() => {});
    loadPicker().then((gs) => setPickerFiles(Object.fromEntries(gs.flatMap((g) => g.files).map((f) => [f.id, f]))));
  }, []);
  const blocked = !!budget?.blocked;

  // ------------------------------------------------------------------ viewer
  const files = useMemo(() => ({ ...pickerFiles, ...references }), [pickerFiles, references]);
  const openDocument = useCallback<ChatCtx['openDocument']>((docId, jump, fallbackName) => {
    const d = docs[docId];
    viewer.open(
      { source: 'document', id: docId, name: d?.name || fallbackName || 'Estimate.xlsx', language: d?.language, subtitle: `Generated by the agent · ${fmtWhen(d?.updated_at || d?.created_at)}` },
      jump && jump.row ? { sheet: jump.sheet ?? undefined, row: jump.row } : undefined,
    );
  }, [docs, viewer]);
  const openFile = useCallback<ChatCtx['openFile']>((fileId, name, jump) => {
    const f = files[fileId];
    viewer.open(
      { source: 'file', id: fileId, name: f?.original_name || name || 'File', language: f?.language, subtitle: 'Knowledge base' },
      jump && jump.row ? { sheet: jump.sheet ?? undefined, row: jump.row } : undefined,
    );
  }, [files, viewer]);
  const openUpload = useCallback((id: string, name: string) => {
    viewer.open({ source: 'upload', id, name, subtitle: 'Attached to this chat' });
  }, [viewer]);
  const openRef = useCallback((d: DocRef) => viewer.open(d), [viewer]);

  const askDoc = useCallback((d: DocRef) => {
    const chip: ComposerChip = {
      key: `${d.source}:${d.id}`, source: d.source, id: d.id, name: d.name, language: d.language,
      role: d.source === 'document' ? 'Estimate' : d.source === 'file' ? 'Reference' : uploadRole(d.name),
    };
    composer.current?.addChip(chip);
    floatComposer.current?.addChip(chip);
  }, []);

  // ------------------------------------------------------------------ timeline
  const blockingRun = Object.values(runs).find((r) => BLOCKING.includes(r.status));
  const sorted = useMemo(
    () => Object.values(messages).sort((a, b) => a.created_at.localeCompare(b.created_at) || (a.role === b.role ? 0 : a.role === 'user' ? -1 : 1)),
    [messages],
  );
  const latestDocId = useMemo(() => {
    const ds = Object.values(docs).sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
    return ds.length ? ds[ds.length - 1].id : undefined;
  }, [docs]);
  const language = useMemo(() => {
    const d = latestDocId ? docs[latestDocId] : undefined;
    return d?.language || Object.values(references).find((f) => f.language)?.language || null;
  }, [docs, latestDocId, references]);

  const segments = useMemo(() => {
    const byMessage: Record<string, Segment> = {};
    const tails: Segment[] = [];
    for (const r of Object.values(runs)) {
      const res = anchorSteps(r, sorted.filter((m) => m.role === 'assistant' && m.run_id === r.id));
      Object.assign(byMessage, res.byMessage);
      if (res.tail) tails.push(res.tail);
    }
    return { byMessage, tails };
  }, [runs, sorted]);

  const cardsFor = useMemo(() => {
    const inParts = new Set<string>();
    const out: Record<string, Card[]> = {};
    for (const m of sorted) {
      const list: Card[] = [];
      for (const p of m.parts || []) {
        const id = (p as { card_id?: string }).card_id;
        if (p.type === 'card' && id && cards[id]) { list.push(cards[id]); inParts.add(id); }
      }
      out[m.id] = list;
    }
    const orphans: Card[] = [];
    for (const c of Object.values(cards)) {
      if (inParts.has(c.id)) continue;
      if (c.message_id && out[c.message_id]) out[c.message_id].push(c);
      else orphans.push(c);
    }
    return { out, orphans };
  }, [sorted, cards]);

  const retry = useCallback(async (runId: string | null) => {
    const um = sorted.find((m) => m.role === 'user' && m.run_id === runId);
    if (!um) return;
    setSendError(null);
    try {
      const r = await api<{ message: ChatMessage; run: { id: string; status: string } }>(`/api/conversations/${conversationId}/messages`, {
        method: 'POST', json: { text: um.content, attachment_ids: um.attachment_ids || [], reference_ids: um.reference_ids || [] },
      });
      conv.onSent(r.message, r.run);
    } catch (e) {
      setSendError(sendErrorText(e));
    }
  }, [sorted, conversationId, conv]);

  const stepsNode = (seg: Segment | undefined) =>
    seg ? (
      <StepsBlock key={`steps-${seg.runId}`} steps={seg.steps} status={seg.status} startedAt={seg.startedAt} endedAt={seg.endedAt}
        docId={Object.values(docs).find((d) => d.run_id === seg.runId)?.id ?? latestDocId}
        onStop={() => conv.stop(seg.runId).catch((e) => setSendError((e as Error).message))} />
    ) : null;

  const items: { at: string; order: number; node: ReactNode }[] = [];
  for (const m of sorted) {
    // An answer that ended empty (its run failed or was stopped before any text) shows nothing.
    if (m.role === 'assistant' && !m.streaming && !m.content && !(m.parts || []).length && !(cardsFor.out[m.id] || []).length && !segments.byMessage[m.id]) continue;
    if (m.role === 'user') items.push({ at: m.created_at, order: 0, node: <UserMessage key={m.id} m={m} uploads={uploads} references={references} /> });
    else
      items.push({
        at: m.created_at, order: 2,
        node: <AgentMessage key={m.id} m={m} cards={cardsFor.out[m.id] || []} steps={stepsNode(segments.byMessage[m.id])} latestDocId={latestDocId}
          onRetry={m.run_id ? () => retry(m.run_id) : undefined} />,
      });
  }
  for (const seg of segments.tails) {
    const r = runs[seg.runId];
    items.push({ at: r?.created_at || new Date(seg.startedAt).toISOString(), order: 1, node: <div key={`tail-${seg.runId}`}>{stepsNode(seg)}</div> });
  }
  for (const c of cardsFor.orphans)
    items.push({ at: c.created_at, order: 2, node: <AgentMessage key={`card-${c.id}`} m={{ id: c.id, run_id: c.run_id, role: 'assistant', content: '', parts: [], created_at: c.created_at }} cards={[c]} showFooter={false} /> });
  // A run that is queued / starting and has shown nothing yet: a quiet "working" line.
  for (const r of Object.values(runs)) {
    if (!BLOCKING.includes(r.status) || r.stepOrder.length || sorted.some((m) => m.role === 'assistant' && m.run_id === r.id)) continue;
    items.push({ at: r.created_at || new Date().toISOString(), order: 1, node: <StepsBlock key={`q-${r.id}`} steps={[]} status="running" startedAt={Date.parse(r.created_at || '') || Date.now()} onStop={() => conv.stop(r.id)} /> });
  }
  // A failed run says so (with Retry on its answer, or here when it produced none).
  for (const r of Object.values(runs)) {
    if (r.status !== 'failed') continue;
    const last = sorted.filter((m) => m.run_id === r.id).pop();
    // The worker normally explains a failure in a message of its own.
    if (sorted.some((m) => m.run_id === r.id && m.role === 'assistant' && m.content)) continue;
    items.push({
      at: last?.created_at || r.created_at || '', order: 3,
      node: (
        <div key={`fail-${r.id}`} role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 14, color: 'var(--err)' }}>
          <span>Something went wrong{r.error ? `: ${r.error}` : ''}.</span>
          <button type="button" className="hv-errSoft" onClick={() => retry(r.id)}
            style={{ height: 28, padding: '0 10px', border: '1px solid var(--err)', borderRadius: 7, background: 'transparent', color: 'var(--err)', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}>Try again</button>
        </div>
      ),
    });
  }
  items.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);

  // ------------------------------------------------------------------ auto-scroll to the newest message
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current, content = inner.current;
    if (!el || !content) return;
    const onScroll = () => { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140; };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    ro.observe(content);
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, [conv.loaded]);

  // ------------------------------------------------------------------ send
  const send = useCallback(async (text: string, chips: ComposerChip[], fromFloat = false) => {
    setSendError(null);
    try {
      const r = await postChatMessage(conversationId, text, chips);
      stick.current = true;
      conv.onSent(r.message, r.run);
      if (fromFloat) setFloatSentAt(r.message.created_at);
      refreshConversations();
      return true;
    } catch (e) {
      setSendError(sendErrorText(e));
      if (e && (e as { body?: { error?: string } }).body?.error === 'budget_paused') api<Budget>('/api/budget/status').then(setBudget).catch(() => {});
      return false;
    }
  }, [conversationId, conv, refreshConversations]);

  const floatReply = useMemo(() => {
    if (!floatSentAt) return null;
    const replies = sorted.filter((m) => m.role === 'assistant' && m.created_at >= floatSentAt);
    return replies.length ? replies[replies.length - 1] : null;
  }, [sorted, floatSentAt]);

  const ctx: ChatCtx = useMemo(() => ({
    docs, runs, files, openDocument, openFile, openUpload,
    onCard: conv.upsertCard, followRun: conv.followRun, stopRun: (id: string) => { conv.stop(id).catch(() => {}); },
  }), [docs, runs, files, openDocument, openFile, openUpload, conv.upsertCard, conv.followRun, conv]);

  if (loadError)
    return (
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 16px 0 6px' }}><MenuButton /></header>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24, textAlign: 'center' }}>
          <div role="alert" style={{ fontSize: 16, fontWeight: 600 }}>{loadError}</div>
          <Link href="/chat" style={{ fontSize: 14 }}>Start a new estimate</Link>
        </div>
      </main>
    );

  const placeholder = viewer.isOpen ? 'Ask about this document…' : 'Reply to the agent. Type / to add reference files.';
  const composerNode = (
    <Composer ref={composer} conversationId={conversationId} placeholder={placeholder} disabled={blocked} busy={!!blockingRun}
      onSend={(t, c) => send(t, c)} onOpenDoc={openRef} error={sendError} />
  );

  return (
    <ChatContext.Provider value={ctx}>
      <ViewerLayout viewer={viewer} onAsk={askDoc} railLabel="Chat"
        renderAsk={() => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {floatReply && (
              <div className="scroll-thin" style={{ maxHeight: 260, overflow: 'auto', padding: '14px 16px', border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)' }}>
                <AgentMessage m={floatReply} cards={cardsFor.out[floatReply.id] || []} latestDocId={latestDocId} showFooter={false} />
              </div>
            )}
            <Composer ref={floatComposer} conversationId={conversationId} placeholder="Ask about this document" disabled={blocked} busy={!!blockingRun}
              onSend={(t, c) => send(t, c, true)} onOpenDoc={openRef} error={sendError} autoFocus />
          </div>
        )}>
        <main style={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
          <header style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: `0 16px 0 ${mobile ? '6px' : '20px'}` }}>
            <MenuButton />
            <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 500, fontSize: 14.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{conv.title || (conv.loaded ? 'New estimate' : '')}</span>
              <LangTag lang={language} />
            </div>
            <div style={{ flex: 1 }} />
            {!mobile && (
              <span style={{ fontSize: 12, color: 'var(--ink3)', whiteSpace: 'nowrap' }}>
                Conversation cost <span style={{ fontFamily: 'var(--mono)' }}>{fmtUsd(convCost, convCost > 0 && convCost < 0.01 ? 4 : 2)}</span>
              </span>
            )}
          </header>
          <div ref={scroller} className="scroll-thin" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <div ref={inner} style={{ maxWidth: 760, margin: '0 auto', padding: '12px 20px 32px', display: 'flex', flexDirection: 'column', gap: 28 }}>
              {items.map((i) => i.node)}
            </div>
          </div>
          <div style={{ flex: 'none', padding: '0 16px 16px' }}>
            <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {blocked && budget && (
                <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', border: '1px solid var(--err)', borderRadius: 12, background: 'var(--errSoft)', fontSize: 13.5, flexWrap: mobile ? 'wrap' : 'nowrap' }}>
                  <span style={{ width: 20, height: 20, flex: 'none', borderRadius: '50%', background: 'var(--err)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>!</span>
                  <span style={{ flex: 1, minWidth: 200 }}>
                    Monthly AI budget reached ({fmtUsd(budget.spent_usd, 0)} of {fmtUsd(budget.amount_usd, 0)}). New messages are paused until {firstOfNextMonth()} or until an admin raises the budget. You can still open and download estimates.
                  </span>
                  <Link href="/settings/usage" style={{ flex: 'none', fontWeight: 600 }}>Budget settings</Link>
                </div>
              )}
              {composerNode}
            </div>
          </div>
        </main>
      </ViewerLayout>
    </ChatContext.Provider>
  );
}
