'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, usd } from '@/lib/client';
import { DocViewer } from '@/components/DocViewer';
import { CardView, type Card } from './CardView';

interface Message {
  id: string;
  run_id: string | null;
  role: 'user' | 'assistant';
  content: string;
  parts: any[];
  tier?: string | null;
  model_id?: string | null;
  cost_usd?: number | null;
  created_at: string;
  streaming?: boolean;
}
interface Step {
  step_id: string;
  label: string;
  done?: number;
  total?: number;
  state: 'running' | 'done';
  summary?: string;
  warns: { message: string; rows?: { sheet: string; row: number; label: string }[] }[];
}
interface LiveRun {
  id: string;
  status: string;
  error?: string;
  steps: Record<string, Step>;
  stepOrder: string[];
  cost?: number;
  connection: 'connecting' | 'open' | 'closed' | 'error';
}
interface Doc {
  id: string;
  name: string;
  totals?: any;
  created_at: string;
}
interface PickerFile {
  id: string;
  original_name: string;
  tag: string;
}

const TERMINAL = ['done', 'failed', 'cancelled'];
const BLOCKING = ['queued', 'running'];

export function ChatView({ conversationId }: { conversationId: string | null }) {
  const router = useRouter();
  const search = useSearchParams();
  const [title, setTitle] = useState('New estimate');
  const [messages, setMessages] = useState<Record<string, Message>>({});
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [docs, setDocs] = useState<Record<string, Doc>>({});
  const [runs, setRuns] = useState<Record<string, LiveRun>>({});
  const [convCost, setConvCost] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [locked, setLocked] = useState<boolean | null>(null);
  const sources = useRef<Record<string, EventSource>>({});

  // ---------------------------------------------------------------- state helpers
  const upsertMessage = useCallback((m: Partial<Message> & { id: string }) => {
    setMessages((cur) => ({ ...cur, [m.id]: { ...(cur[m.id] || { role: 'assistant', content: '', parts: [], run_id: null, created_at: new Date().toISOString() }), ...m } as Message }));
  }, []);
  const upsertCard = useCallback((c: Card) => setCards((cur) => ({ ...cur, [c.id]: c })), []);
  const patchRun = useCallback((id: string, fn: (r: LiveRun) => LiveRun) => {
    setRuns((cur) => {
      const r = cur[id] || { id, status: 'queued', steps: {}, stepOrder: [], connection: 'connecting' as const };
      return { ...cur, [id]: fn(r) };
    });
  }, []);

  const load = useCallback(async () => {
    if (!conversationId) return null;
    try {
      const d = await api<any>(`/api/conversations/${conversationId}`);
      setTitle(d.conversation.title);
      setMessages(Object.fromEntries(d.messages.map((m: Message) => [m.id, m])));
      setCards(Object.fromEntries(d.cards.map((c: Card) => [c.id, c])));
      setDocs(Object.fromEntries(d.documents.map((x: Doc) => [x.id, x])));
      setConvCost(d.total_cost_usd);
      return d;
    } catch (e) {
      setLoadError(e instanceof ApiError && e.status === 404 ? 'Conversation not found.' : String((e as Error).message));
      return null;
    }
  }, [conversationId]);

  // ---------------------------------------------------------------- SSE
  const subscribe = useCallback(
    (runId: string, status = 'queued') => {
      if (sources.current[runId]) return;
      patchRun(runId, (r) => ({ ...r, status: r.status || status, connection: 'connecting' }));
      // Replay from the start of the run so the live view is rebuilt after a reload; EventSource's own
      // reconnects send Last-Event-ID, which the proxy prefers over ?after.
      const es = new EventSource(`/api/runs/${runId}/events?after=0`);
      sources.current[runId] = es;
      const data = (e: MessageEvent) => {
        try {
          const j = JSON.parse(e.data);
          return j && typeof j === 'object' && 'payload' in j && 'type' in j ? j.payload : j;
        } catch {
          return {};
        }
      };
      es.onopen = () => patchRun(runId, (r) => ({ ...r, connection: 'open' }));
      es.onerror = () => patchRun(runId, (r) => ({ ...r, connection: TERMINAL.includes(r.status) ? 'closed' : 'error' }));
      es.addEventListener('run.status', (e) => {
        const p = data(e as MessageEvent);
        patchRun(runId, (r) => ({ ...r, status: p.status, error: p.error }));
        if (TERMINAL.includes(p.status)) {
          es.close();
          delete sources.current[runId];
          patchRun(runId, (r) => ({ ...r, connection: 'closed' }));
          load();
        }
      });
      es.addEventListener('step.started', (e) => {
        const p = data(e as MessageEvent);
        patchRun(runId, (r) => ({
          ...r,
          stepOrder: r.stepOrder.includes(p.step_id) ? r.stepOrder : [...r.stepOrder, p.step_id],
          steps: { ...r.steps, [p.step_id]: { step_id: p.step_id, label: p.label, total: p.total, done: 0, state: 'running', warns: r.steps[p.step_id]?.warns || [] } },
        }));
      });
      es.addEventListener('step.progress', (e) => {
        const p = data(e as MessageEvent);
        patchRun(runId, (r) => {
          const s = r.steps[p.step_id] || { step_id: p.step_id, label: p.label || p.step_id, state: 'running' as const, warns: [] };
          return {
            ...r,
            stepOrder: r.stepOrder.includes(p.step_id) ? r.stepOrder : [...r.stepOrder, p.step_id],
            steps: { ...r.steps, [p.step_id]: { ...s, done: p.done, total: p.total, label: p.label || s.label } },
          };
        });
      });
      es.addEventListener('step.done', (e) => {
        const p = data(e as MessageEvent);
        patchRun(runId, (r) => {
          const s = r.steps[p.step_id] || { step_id: p.step_id, label: p.step_id, warns: [] };
          return { ...r, steps: { ...r.steps, [p.step_id]: { ...s, state: 'done', summary: p.summary } as Step } };
        });
      });
      es.addEventListener('step.warn', (e) => {
        const p = data(e as MessageEvent);
        patchRun(runId, (r) => {
          const s = r.steps[p.step_id] || { step_id: p.step_id, label: p.step_id, state: 'running' as const, warns: [] };
          return {
            ...r,
            stepOrder: r.stepOrder.includes(p.step_id) ? r.stepOrder : [...r.stepOrder, p.step_id],
            steps: { ...r.steps, [p.step_id]: { ...s, warns: [...s.warns, { message: p.message, rows: p.rows }] } },
          };
        });
      });
      es.addEventListener('message.created', (e) => {
        const p = data(e as MessageEvent);
        if (p.message?.id) upsertMessage({ ...p.message, content: '', streaming: true });
      });
      es.addEventListener('text.delta', (e) => {
        const p = data(e as MessageEvent);
        setMessages((cur) => {
          const m = cur[p.message_id] || { id: p.message_id, role: 'assistant', content: '', parts: [], run_id: runId, created_at: new Date().toISOString() };
          return { ...cur, [p.message_id]: { ...m, content: m.content + (p.delta || ''), streaming: true } as Message };
        });
      });
      es.addEventListener('message.completed', (e) => {
        const p = data(e as MessageEvent);
        upsertMessage({ id: p.message_id, content: p.content, parts: p.parts || [], tier: p.tier, model_id: p.model_id, cost_usd: p.cost_usd, streaming: false });
      });
      es.addEventListener('card.created', (e) => upsertCard(data(e as MessageEvent).card));
      es.addEventListener('card.updated', (e) => upsertCard(data(e as MessageEvent).card));
      es.addEventListener('document.ready', (e) => {
        const d = data(e as MessageEvent).document;
        if (d?.id) setDocs((cur) => ({ ...cur, [d.id]: d }));
      });
      es.addEventListener('cost.update', (e) => {
        const p = data(e as MessageEvent);
        patchRun(runId, (r) => ({ ...r, cost: p.run_cost_usd }));
        if (p.conversation_cost_usd !== undefined) setConvCost(p.conversation_cost_usd);
      });
      es.addEventListener('proxy.error', () => patchRun(runId, (r) => ({ ...r, connection: 'error' })));
    },
    [load, patchRun, upsertCard, upsertMessage],
  );

  useEffect(() => {
    api<{ chatUnlocked: boolean }>('/api/knowledge/status').then((s) => setLocked(!s.chatUnlocked)).catch(() => {});
    load().then((d) => {
      // Re-attach to every non-terminal run (reload / new tab).
      for (const r of d?.active_runs || []) {
        patchRun(r.id, (x) => ({ ...x, status: r.status }));
        subscribe(r.id, r.status);
      }
    });
    const srcs = sources.current;
    return () => {
      for (const es of Object.values(srcs)) es.close();
      sources.current = {};
    };
  }, [load, subscribe, patchRun]);

  // ---------------------------------------------------------------- timeline
  const cardsInParts = useMemo(() => {
    const s = new Set<string>();
    for (const m of Object.values(messages)) for (const p of m.parts || []) if (p?.type === 'card' && p.card_id) s.add(p.card_id);
    return s;
  }, [messages]);
  const timeline = useMemo(() => {
    const items: { at: string; kind: 'message' | 'card'; id: string }[] = [
      ...Object.values(messages).map((m) => ({ at: m.created_at, kind: 'message' as const, id: m.id })),
      ...Object.values(cards).filter((c) => !cardsInParts.has(c.id)).map((c) => ({ at: c.created_at, kind: 'card' as const, id: c.id })),
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [messages, cards, cardsInParts]);

  const [pickerFiles, setPickerFiles] = useState<PickerFile[]>([]);
  useEffect(() => {
    api<{ groups: { tag: string; files: PickerFile[] }[] }>('/api/picker')
      .then((r) => setPickerFiles(r.groups.flatMap((g) => g.files)))
      .catch(() => {});
  }, []);

  const liveRuns = Object.values(runs);
  const blockingRun = liveRuns.find((r) => BLOCKING.includes(r.status));
  const viewDoc = search.get('doc');

  if (loadError) return <p role="alert">{loadError}</p>;

  return (
    <>
      <h1>{title}</h1>
      <p>
        Conversation cost: {usd(convCost, 4)} {conversationId && <Link href="/history">· History</Link>}
      </p>

      {locked && (
        <p role="alert">
          Chat is locked: add and analyse at least one reference estimate first. <Link href="/setup">Go to setup →</Link>
        </p>
      )}

      <ol aria-label="Messages">
        {timeline.map((t) =>
          t.kind === 'message' ? (
            <li key={t.id}>
              <MessageView m={messages[t.id]} cards={cards} onCard={upsertCard} pickerFiles={pickerFiles} />
            </li>
          ) : (
            <li key={t.id}>
              <CardView card={cards[t.id]} onCard={upsertCard} pickerFiles={pickerFiles} />
            </li>
          ),
        )}
      </ol>

      {liveRuns.filter((r) => r.stepOrder.length > 0 || !TERMINAL.includes(r.status)).map((r) => (
        <RunPanel key={r.id} run={r} />
      ))}

      {Object.values(docs).length > 0 && (
        <section>
          <h2>Documents</h2>
          <ul>
            {Object.values(docs).map((d) => (
              <li key={d.id}>
                {d.name} — <a href={`/api/documents/${d.id}/download`}>Download</a> · <Link href={`?doc=${d.id}`}>View</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {viewDoc && (
        <DocViewer
          key={`${viewDoc}:${search.get('sheet')}:${search.get('row')}`}
          kind="document"
          id={viewDoc}
          initialSheet={search.get('sheet') || undefined}
          initialRow={search.get('row') ? Number(search.get('row')) : undefined}
        />
      )}

      {locked === false && (
        <Composer
          conversationId={conversationId}
          pickerFiles={pickerFiles}
          busyRun={blockingRun}
          onSent={(convId, message, run) => {
            if (!conversationId) {
              router.push(`/chat/${convId}`);
              return;
            }
            upsertMessage(message);
            patchRun(run.id, (x) => ({ ...x, status: run.status }));
            subscribe(run.id, run.status);
          }}
        />
      )}
    </>
  );
}

function RunPanel({ run }: { run: LiveRun }) {
  async function stop() {
    await api(`/api/runs/${run.id}/stop`, { method: 'POST' }).catch((e) => alert(e.message));
  }
  const steps = run.stepOrder.map((id) => run.steps[id]).filter(Boolean);
  return (
    <section aria-label="Run progress">
      <p>
        Run {run.status}
        {run.error && <> — {run.error}</>}
        {run.cost !== undefined && <> · {usd(run.cost, 4)}</>}
        {run.connection === 'error' && <> · reconnecting…</>}{' '}
        {!TERMINAL.includes(run.status) && <button type="button" onClick={stop}>Stop</button>}
      </p>
      <ul>
        {steps.map((s) => (
          <li key={s.step_id}>
            {s.state === 'done' ? '✓' : '…'} {s.label}
            {s.total ? <> ({s.done ?? 0}/{s.total}) <progress max={s.total} value={s.done ?? 0} /></> : null}
            {s.summary && <> — {s.summary}</>}
            {s.warns.length > 0 && (
              <ul>
                {s.warns.map((w, i) => (
                  <li key={i}>
                    ⚠ {w.message}
                    {w.rows?.length ? <> ({w.rows.map((r) => `${r.sheet}!${r.row}`).join(', ')})</> : null}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Line breaks without CSS (the design import will replace this). */
function Lines({ text }: { text: string }) {
  const lines = String(text ?? '').split('\n');
  return (
    <p>
      {lines.map((l, i) => (
        <span key={i}>
          {l}
          {i < lines.length - 1 && <br />}
        </span>
      ))}
    </p>
  );
}

function MessageView({ m, cards, onCard, pickerFiles }: { m: Message; cards: Record<string, Card>; onCard: (c: Card) => void; pickerFiles: PickerFile[] }) {
  const parts = (m.parts || []) as any[];
  const hasTextPart = parts.some((p) => p?.type === 'text');
  return (
    <article aria-label={`${m.role} message`}>
      <p>
        <b>{m.role === 'user' ? 'You' : 'Agent'}</b>
        {m.tier && <small> · {m.tier}</small>}
        {m.cost_usd !== null && m.cost_usd !== undefined && m.role === 'assistant' && <small> · {usd(m.cost_usd, 4)}</small>}
        {m.streaming && <small> · typing…</small>}
      </p>
      {(m.streaming || !hasTextPart) && m.content && <Lines text={m.content} />}
      {!m.streaming &&
        parts.map((p, i) => {
          if (p?.type === 'text') return <Lines key={i} text={p.text} />;
          if (p?.type === 'chip' && p.kind === 'row')
            return (
              <a key={i} href={`?doc=${p.document_id}&sheet=${encodeURIComponent(p.sheet)}&row=${p.row}`}>
                [{p.label || `${p.sheet}!${p.row}`}]{' '}
              </a>
            );
          if (p?.type === 'chip' && p.kind === 'file')
            return (
              <Link key={i} href={`/knowledge/${p.file_id}`}>
                [{p.label || 'file'}]{' '}
              </Link>
            );
          if (p?.type === 'card' && cards[p.card_id]) return <CardView key={i} card={cards[p.card_id]} onCard={onCard} pickerFiles={pickerFiles} />;
          if (p?.type === 'steps') return <pre key={i}>{JSON.stringify(p.steps ?? p, null, 1)}</pre>;
          return null;
        })}
    </article>
  );
}

function Composer({
  conversationId,
  pickerFiles,
  busyRun,
  onSent,
}: {
  conversationId: string | null;
  pickerFiles: PickerFile[];
  busyRun?: LiveRun;
  onSent: (conversationId: string, message: any, run: any) => void;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<{ id: string; original_name: string }[]>([]);
  const [refs, setRefs] = useState<PickerFile[]>([]);
  const [picker, setPicker] = useState(false);
  const [hint, setHint] = useState<string>('');
  const [budget, setBudget] = useState<{ state: string; action: string; blocked: boolean; fast_only: boolean; message: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ text: string }>('/api/composer-hint').then((h) => setHint(h.text)).catch(() => {});
    api('/api/budget/status').then(setBudget).catch(() => {});
  }, []);

  const paused = !!budget && budget.state === 'over' && budget.action === 'pause';

  async function attach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      const fd = new FormData();
      fd.set('file', f);
      if (conversationId) fd.set('conversation_id', conversationId);
      try {
        const r = await api<{ upload: { id: string; original_name: string } }>('/api/uploads', { method: 'POST', body: fd });
        setAttachments((a) => [...a, r.upload]);
      } catch (err) {
        setError(`${f.name}: ${(err as Error).message}`);
      }
    }
    e.target.value = '';
  }

  function onChange(v: string) {
    setText(v);
    if (/(^|\s)\/$/.test(v)) setPicker(true);
  }

  function pick(f: PickerFile) {
    setRefs((r) => (r.some((x) => x.id === f.id) ? r : [...r, f]));
    setText((t) => t.replace(/(^|\s)\/$/, '$1'));
    setPicker(false);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      let convId = conversationId;
      if (!convId) {
        const c = await api<{ conversation: { id: string } }>('/api/conversations', { method: 'POST', json: {} });
        convId = c.conversation.id;
      }
      const r = await api<{ message: any; run: any }>(`/api/conversations/${convId}/messages`, {
        method: 'POST',
        json: { text, attachment_ids: attachments.map((a) => a.id), reference_ids: refs.map((f) => f.id) },
      });
      setText('');
      setAttachments([]);
      setRefs([]);
      onSent(convId, r.message, r.run);
    } catch (err) {
      const b = err instanceof ApiError ? err.body : {};
      if (b.error === 'budget_paused') setError('The monthly budget is used up; chat is paused.');
      else if (b.error === 'chat_locked') setError('Chat is locked until a reference estimate is analysed.');
      else if (b.error === 'run_active') setError('Wait for the current answer to finish (or stop it).');
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const disabled = paused || busy || !!busyRun;
  return (
    <form onSubmit={send} aria-label="Composer">
      {budget?.message && <p role="status">{budget.message}</p>}
      {budget?.fast_only && <p role="status">Budget reached: answers use the fast model only.</p>}
      {refs.length > 0 && (
        <p>
          References:{' '}
          {refs.map((f) => (
            <span key={f.id}>
              [{f.original_name} <button type="button" onClick={() => setRefs((r) => r.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.original_name}`}>×</button>]{' '}
            </span>
          ))}
        </p>
      )}
      {attachments.length > 0 && (
        <p>
          Attachments:{' '}
          {attachments.map((a) => (
            <span key={a.id}>
              [{a.original_name} <button type="button" onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))} aria-label={`Remove ${a.original_name}`}>×</button>]{' '}
            </span>
          ))}
        </p>
      )}
      <p>
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          cols={80}
          disabled={paused}
          placeholder={paused ? 'Chat is paused: monthly budget reached' : 'Ask, or attach a blank to fill. Type / to pick reference files.'}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPicker(false);
          }}
        />
      </p>
      {picker && (
        <div role="listbox" aria-label="Pick reference files">
          {pickerFiles.length === 0 && <p>No analysed files.</p>}
          {Object.entries(
            pickerFiles.reduce<Record<string, PickerFile[]>>((acc, f) => ((acc[f.tag] ||= []).push(f), acc), {}),
          ).map(([tag, files]) => (
            <div key={tag}>
              <b>{tag}</b>
              <ul>
                {files.map((f) => (
                  <li key={f.id}>
                    <button type="button" role="option" aria-selected={refs.some((r) => r.id === f.id)} onClick={() => pick(f)}>
                      {f.original_name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <button type="button" onClick={() => setPicker(false)}>Close</button>
        </div>
      )}
      <p>
        <input ref={fileInput} type="file" hidden multiple accept=".xlsx,.xls,.docx,.pdf,.txt,.csv" onChange={attach} />
        <button type="button" onClick={() => fileInput.current?.click()} disabled={paused}>Attach</button>{' '}
        <button type="button" onClick={() => setPicker((p) => !p)} disabled={paused}>/ References</button>{' '}
        <button type="submit" disabled={disabled || !text.trim()}>{busy ? 'Sending…' : 'Send'}</button>{' '}
        <small>{hint}</small>
      </p>
      {busyRun && <p role="status">The agent is working… you can stop it above.</p>}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
