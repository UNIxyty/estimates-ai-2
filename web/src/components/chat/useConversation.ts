'use client';

/**
 * Conversation state: GET /api/conversations/{id} + one EventSource per non-terminal run
 * (/api/runs/{id}/events). EventSource reconnects on its own and sends Last-Event-ID, so a dropped stream
 * resumes where it stopped; a reload replays the run from seq 0 and rebuilds the live view.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/client';
import { TERMINAL, type Card, type ChatMessage, type Doc, type FileRef, type LiveRun, type Step, type UploadRef } from './types';

interface StepEventRow { run_id: string; seq: number; type: string; payload: any; created_at: string }

const blankRun = (id: string): LiveRun => ({ id, status: 'queued', steps: {}, stepOrder: [], connection: 'none' });

/** Applies one step.* event to a run (used for live events and for the stored events after a reload). */
export function applyStepEvent(r: LiveRun, type: string, p: any, at: number): LiveRun {
  const id = String(p?.step_id ?? '');
  if (!id) return r;
  const cur: Step | undefined = r.steps[id];
  const order = r.stepOrder.includes(id) ? r.stepOrder : [...r.stepOrder, id];
  const base: Step = cur ?? { step_id: id, label: p.label || '', state: 'running', warns: [], startedAt: at };
  let next: Step = base;
  if (type === 'step.started') {
    next = { ...base, label: p.label || base.label, total: p.total ?? base.total, done: cur ? base.done : 0, state: cur?.state === 'done' ? 'done' : 'running', startedAt: cur ? base.startedAt : at };
  } else if (type === 'step.progress') {
    next = { ...base, done: p.done, total: p.total ?? base.total, label: p.label || base.label, current: p.current ?? base.current, endedAt: base.state === 'done' ? base.endedAt : at };
  } else if (type === 'step.done') {
    // A replayed event (stream re-opened from seq 0) must not move a known end time to "now".
    next = { ...base, state: 'done', summary: p.summary ?? base.summary, endedAt: base.state === 'done' && base.endedAt ? base.endedAt : at, current: null };
  } else if (type === 'step.warn') {
    const dup = base.warns.some((w) => w.message === p.message);
    next = { ...base, warns: dup ? base.warns : [...base.warns, { message: p.message, rows: p.rows }], endedAt: dup ? base.endedAt : at };
  } else return r;
  return { ...r, stepOrder: order, steps: { ...r.steps, [id]: next } };
}

export function useConversation(conversationId: string, opts: { onRunEnd?: () => void } = {}) {
  const [title, setTitle] = useState('');
  const [messages, setMessages] = useState<Record<string, ChatMessage>>({});
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [docs, setDocs] = useState<Record<string, Doc>>({});
  const [runs, setRuns] = useState<Record<string, LiveRun>>({});
  const [uploads, setUploads] = useState<Record<string, UploadRef>>({});
  const [references, setReferences] = useState<Record<string, FileRef>>({});
  const [convCost, setConvCost] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const sources = useRef<Record<string, EventSource>>({});
  /** Last seq seen per run (reopening a closed stream continues from there). */
  const lastSeq = useRef<Record<string, number>>({});
  /** Runs we expect to resume (a card decision was made): keep re-opening their stream until this time. */
  const expectUntil = useRef<Record<string, number>>({});
  const onRunEnd = useRef(opts.onRunEnd);
  onRunEnd.current = opts.onRunEnd;

  const upsertMessage = useCallback((m: Partial<ChatMessage> & { id: string }) => {
    setMessages((cur) => ({
      ...cur,
      [m.id]: { ...(cur[m.id] || { role: 'assistant', content: '', parts: [], run_id: null, created_at: new Date().toISOString() }), ...m } as ChatMessage,
    }));
  }, []);
  const upsertCard = useCallback((c: Card) => setCards((cur) => ({ ...cur, [c.id]: c })), []);
  const patchRun = useCallback((id: string, fn: (r: LiveRun) => LiveRun) => {
    setRuns((cur) => ({ ...cur, [id]: fn(cur[id] || blankRun(id)) }));
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await api<any>(`/api/conversations/${conversationId}`);
      setTitle(d.conversation.title);
      setMessages((cur) => {
        const active = new Set<string>((d.active_runs || []).map((r: { id: string }) => r.id));
        // An empty assistant message of an active run is still being written: its text arrives as deltas.
        const next: Record<string, ChatMessage> = Object.fromEntries(
          d.messages.map((m: ChatMessage) => [m.id, m.role === 'assistant' && !m.content && m.run_id && active.has(m.run_id) ? { ...m, streaming: true } : m]),
        );
        // Keep a message that is still streaming (its DB row is empty until message.completed).
        for (const [id, m] of Object.entries(cur)) if (m.streaming && m.run_id && active.has(m.run_id) && (!next[id] || !next[id].content)) next[id] = m;
        return next;
      });
      setCards(Object.fromEntries(d.cards.map((c: Card) => [c.id, c])));
      setDocs(Object.fromEntries(d.documents.map((x: Doc) => [x.id, x])));
      setConvCost(d.total_cost_usd);
      setUploads(Object.fromEntries((d.uploads || []).map((u: UploadRef) => [u.id, u])));
      setReferences(Object.fromEntries((d.references || []).map((f: FileRef) => [f.id, f])));
      // Rebuild every run's steps from the stored step events (live streams then keep them current).
      const events: StepEventRow[] = d.step_events || [];
      setRuns((cur) => {
        const next: Record<string, LiveRun> = { ...cur };
        for (const r of d.runs || []) {
          const live = cur[r.id];
          let run: LiveRun = { ...(live || blankRun(r.id)), status: live && live.connection === 'open' ? live.status : r.status, error: r.error ?? undefined, created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at };
          if (!live || live.stepOrder.length === 0) {
            run = { ...run, steps: {}, stepOrder: [] };
            for (const e of events) if (e.run_id === r.id) run = applyStepEvent(run, e.type, e.payload, Date.parse(e.created_at));
          }
          next[r.id] = run;
        }
        return next;
      });
      setLoaded(true);
      return d;
    } catch (e) {
      setLoadError(e instanceof ApiError && e.status === 404 ? 'Conversation not found.' : String((e as Error).message));
      return null;
    }
  }, [conversationId]);

  const subscribe = useCallback(
    (runId: string, status = 'queued') => {
      if (sources.current[runId]) return;
      patchRun(runId, (r) => ({ ...r, status: r.status && r.status !== 'queued' ? r.status : status, connection: 'connecting' }));
      // First open: replay from the start of the run so the live view is rebuilt after a reload. Re-opening
      // (after a card decision) continues from the last seq. EventSource's own reconnects send
      // Last-Event-ID, which the proxy prefers over ?after.
      const es = new EventSource(`/api/runs/${runId}/events?after=${lastSeq.current[runId] ?? 0}`);
      sources.current[runId] = es;
      const data = (e: Event) => {
        const id = Number((e as MessageEvent).lastEventId);
        if (Number.isFinite(id) && id > (lastSeq.current[runId] ?? 0)) lastSeq.current[runId] = id;
        try {
          const j = JSON.parse((e as MessageEvent).data);
          return j && typeof j === 'object' && 'payload' in j && 'type' in j ? j.payload : j;
        } catch {
          return {};
        }
      };
      const close = () => {
        es.close();
        if (sources.current[runId] === es) delete sources.current[runId];
        patchRun(runId, (r) => ({ ...r, connection: 'closed' }));
        // A decided card resumes the run a few seconds later (Undo window): look again until it does.
        if ((expectUntil.current[runId] ?? 0) > Date.now()) setTimeout(() => subscribe(runId, 'running'), 2500);
      };
      es.onopen = () => patchRun(runId, (r) => ({ ...r, connection: 'open' }));
      es.onerror = () => patchRun(runId, (r) => ({ ...r, connection: TERMINAL.includes(r.status) ? 'closed' : 'error' }));
      es.addEventListener('run.status', (e) => {
        const p = data(e);
        patchRun(runId, (r) => ({ ...r, status: p.status, error: p.error, activity: p.status === 'running' ? r.activity : undefined }));
        if (TERMINAL.includes(p.status)) {
          // The stream itself ends with an `end` event once the run is terminal and fully sent (a replayed
          // old status does not close it: the run may have been resumed since).
          load();
          onRunEnd.current?.();
        } else delete expectUntil.current[runId];
      });
      es.addEventListener('end', () => close());
      es.addEventListener('agent.state', (e) => {
        const p = data(e);
        patchRun(runId, (r) => ({
          ...r,
          activity: !p.state || p.state === 'idle' ? undefined
            : { state: p.state, tier: p.tier, task: p.task, query: p.query, since: r.activity && r.activity.state === p.state ? r.activity.since : Date.now() },
        }));
      });
      for (const t of ['step.started', 'step.progress', 'step.done', 'step.warn'])
        es.addEventListener(t, (e) => {
          const p = data(e);
          patchRun(runId, (r) => applyStepEvent(r, t, p, Date.now()));
        });
      es.addEventListener('message.created', (e) => {
        const p = data(e);
        // A replayed message.created for a message that is already complete must not blank it.
        if (p.message?.id) setMessages((cur) => (cur[p.message.id] && !cur[p.message.id].streaming ? cur : { ...cur, [p.message.id]: { ...p.message, content: '', streaming: true } }));
      });
      es.addEventListener('text.delta', (e) => {
        const p = data(e);
        setMessages((cur) => {
          const m = cur[p.message_id] || { id: p.message_id, role: 'assistant', content: '', parts: [], run_id: runId, created_at: new Date().toISOString(), streaming: true };
          if (!m.streaming) return cur; // replayed delta of a completed message
          return { ...cur, [p.message_id]: { ...m, content: m.content + (p.delta || ''), streaming: true } as ChatMessage };
        });
      });
      es.addEventListener('message.completed', (e) => {
        const p = data(e);
        upsertMessage({ id: p.message_id, content: p.content, parts: p.parts || [], tier: p.tier, model_id: p.model_id, cost_usd: p.cost_usd, tokens: p.tokens, streaming: false });
      });
      es.addEventListener('card.created', (e) => upsertCard(data(e).card));
      es.addEventListener('card.updated', (e) => upsertCard(data(e).card));
      es.addEventListener('document.ready', (e) => {
        const d = data(e).document;
        if (d?.id) setDocs((cur) => ({ ...cur, [d.id]: { ...cur[d.id], ...d } }));
      });
      es.addEventListener('cost.update', (e) => {
        const p = data(e);
        patchRun(runId, (r) => ({ ...r, cost: p.run_cost_usd }));
        if (p.conversation_cost_usd !== undefined) setConvCost(p.conversation_cost_usd);
      });
      es.addEventListener('proxy.error', () => patchRun(runId, (r) => ({ ...r, connection: 'error' })));
    },
    [load, patchRun, upsertCard, upsertMessage],
  );

  // While a run waits for the worker, show where it is in the queue.
  const queuedIds = Object.values(runs).filter((r) => r.status === 'queued').map((r) => r.id).sort().join(',');
  useEffect(() => {
    if (!queuedIds) return;
    let alive = true;
    const poll = async () => {
      for (const id of queuedIds.split(',')) {
        try {
          const q = await api<{ status: string; ahead: number; running: number }>(`/api/runs/${id}/queue`);
          if (alive) patchRun(id, (r) => ({ ...r, queue: { ahead: q.ahead, running: q.running }, status: r.status === 'queued' && q.status !== 'queued' ? q.status : r.status }));
        } catch {}
      }
    };
    poll();
    const t = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(t); };
  }, [queuedIds, patchRun]);

  useEffect(() => {
    load().then((d) => {
      // Re-attach to every non-terminal run (reload / new tab).
      for (const r of d?.active_runs || []) subscribe(r.id, r.status);
    });
    const srcs = sources.current;
    return () => {
      for (const es of Object.values(srcs)) es.close();
      sources.current = {};
    };
  }, [load, subscribe]);

  /** After POST …/messages: show the user message and follow the new run. */
  const onSent = useCallback(
    (message: ChatMessage, run: { id: string; status: string; created_at?: string }) => {
      upsertMessage(message);
      patchRun(run.id, (x) => ({ ...x, status: run.status, created_at: run.created_at }));
      subscribe(run.id, run.status);
      // Titles are set from the first message; attachments get their conversation id.
      load();
    },
    [load, patchRun, subscribe, upsertMessage],
  );

  /** A card decision can resume a waiting run: make sure its stream is open. */
  const followRun = useCallback((runId: string) => {
    expectUntil.current[runId] = Date.now() + 60_000;
    if (!sources.current[runId]) subscribe(runId, 'running');
  }, [subscribe]);

  const stop = useCallback(async (runId: string) => {
    await api(`/api/runs/${runId}/stop`, { method: 'POST' });
  }, []);

  return { title, setTitle, messages, cards, docs, runs, uploads, references, convCost, loaded, loadError, upsertCard, onSent, followRun, stop, reload: load };
}
