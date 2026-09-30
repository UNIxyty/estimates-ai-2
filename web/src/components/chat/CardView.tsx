'use client';

import { useState } from 'react';
import { api, ApiError, when } from '@/lib/client';

export interface Card {
  id: string;
  run_id: string;
  conversation_id: string;
  message_id: string | null;
  kind: string;
  status: string;
  payload: any;
  decision: any;
  decided_at: string | null;
  expires_at: string | null;
  created_at: string;
}

/** Plain box per card; every button POSTs /api/cards/{id}/decision and shows the returned card state. */
export function CardView({ card, onCard, pickerFiles }: { card: Card; onCard: (c: Card) => void; pickerFiles: { id: string; original_name: string; tag: string }[] }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [instructions, setInstructions] = useState('');
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [refId, setRefId] = useState('');
  const p = card.payload || {};

  async function decide(action: string, data?: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ card: Card }>(`/api/cards/${card.id}/decision`, { method: 'POST', json: { action, data } });
      onCard(r.card);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.body.card) onCard(e.body.card as Card);
        setMsg(e.body.error === 'expired' ? 'This request expired — ask again?' : e.body.error === 'too_late' ? 'Too late to undo.' : e.message);
      } else setMsg('Request failed.');
    } finally {
      setBusy(false);
    }
  }

  const expired = card.status === 'expired' || (card.status === 'pending' && card.expires_at && new Date(card.expires_at) < new Date());

  return (
    <section aria-label={`${card.kind} card`} data-card-kind={card.kind}>
      <fieldset>
        <legend>
          Card: {card.kind} — {card.status}
        </legend>

        {card.kind === 'permission' && (
          <>
            <p>
              Use prices from <a href={`/knowledge/${p.file_id}`}>{p.file_name || p.file_id}</a>? {p.reason}
            </p>
            {Array.isArray(p.rows) && (
              <ul>
                {p.rows.slice(0, 20).map((r: any, i: number) => <li key={i}>{r.sheet}!{r.row}: {r.item}</li>)}
                {p.rows.length > 20 && <li>… {p.rows.length - 20} more</li>}
              </ul>
            )}
            {card.status === 'pending' && !expired && (
              <>
                <button type="button" disabled={busy} onClick={() => decide('allow')}>Allow</button>{' '}
                <button type="button" disabled={busy} onClick={() => decide('deny')}>Deny (search the web)</button>{' '}
                {card.expires_at && <small>expires {when(card.expires_at)}</small>}
              </>
            )}
            {(card.status === 'approved' || card.status === 'denied') && (
              <button type="button" disabled={busy} onClick={() => decide('undo')}>Undo</button>
            )}
            {expired && <button type="button" disabled={busy} onClick={() => decide('ask_again')}>Ask again</button>}
          </>
        )}

        {card.kind === 'structure' && (
          <>
            <p>Proposed structure{p.language ? ` (${p.language})` : ''}:</p>
            <ul>
              {(p.sheets || []).map((s: any, i: number) => (
                <li key={i}>
                  {s.name}
                  <ul>{(s.sections || []).map((sec: any, j: number) => <li key={j}>{typeof sec === 'string' ? sec : sec.title ?? JSON.stringify(sec)}</li>)}</ul>
                </li>
              ))}
            </ul>
            {p.columns && <p>Columns: {(p.columns || []).map((c: any) => (typeof c === 'string' ? c : c.header ?? c.name)).join(', ')}</p>}
            {p.pricing_logic && <ul>{(p.pricing_logic || []).map((l: any, i: number) => <li key={i}>{typeof l === 'string' ? l : JSON.stringify(l)}</li>)}</ul>}
            {card.status === 'pending' && (
              <>
                <button type="button" disabled={busy} onClick={() => decide('generate')}>Generate</button>
                <p>
                  <label>Change: <input value={instructions} onChange={(e) => setInstructions(e.target.value)} size={60} /></label>{' '}
                  <button type="button" disabled={busy || !instructions.trim()} onClick={() => decide('change', { instructions })}>Request change</button>
                </p>
                <p>
                  <label>
                    Use another reference:{' '}
                    <select value={refId} onChange={(e) => setRefId(e.target.value)}>
                      <option value="">—</option>
                      {pickerFiles.filter((f) => f.tag === 'reference_estimate').map((f) => <option key={f.id} value={f.id}>{f.original_name}</option>)}
                    </select>
                  </label>{' '}
                  <button type="button" disabled={busy || !refId} onClick={() => decide('use_reference', { file_id: refId })}>Use reference</button>
                </p>
              </>
            )}
          </>
        )}

        {card.kind === 'clarify' && (
          <>
            {(p.questions || []).map((q: any) => (
              <div key={q.id}>
                <p>{q.text}</p>
                {Array.isArray(q.options) && q.options.length > 0 ? (
                  q.options.map((o: any) => {
                    const val = typeof o === 'string' ? o : o.value ?? o.label;
                    const label = typeof o === 'string' ? o : o.label ?? o.value;
                    const multi = !!q.multi;
                    const cur = answers[q.id];
                    const checked = multi ? Array.isArray(cur) && cur.includes(val) : cur === val;
                    return (
                      <label key={String(val)}>
                        <input
                          type={multi ? 'checkbox' : 'radio'}
                          name={`q-${card.id}-${q.id}`}
                          disabled={card.status !== 'pending'}
                          checked={checked}
                          onChange={(e) =>
                            setAnswers((a) => {
                              if (!multi) return { ...a, [q.id]: val };
                              const arr = new Set(Array.isArray(a[q.id]) ? (a[q.id] as unknown[]) : []);
                              if (e.target.checked) arr.add(val);
                              else arr.delete(val);
                              return { ...a, [q.id]: [...arr] };
                            })
                          }
                        />{' '}
                        {label}{' '}
                      </label>
                    );
                  })
                ) : (
                  <input disabled={card.status !== 'pending'} value={String(answers[q.id] ?? '')} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} />
                )}
              </div>
            ))}
            {card.status === 'pending' && <button type="button" disabled={busy} onClick={() => decide('answer', { answers })}>Answer</button>}
            {card.status === 'answered' && card.decision?.data?.answers && <p>Answered: {JSON.stringify(card.decision.data.answers)}</p>}
          </>
        )}

        {card.kind === 'email' && (
          <>
            <p>Email to {p.to}{p.document_id && <> — <a href={`/api/documents/${p.document_id}/download`}>attachment</a></>}</p>
            {card.status === 'failed' && <button type="button" disabled={busy} onClick={() => decide('retry')}>Retry</button>}
          </>
        )}

        {card.kind === 'cost_cap' && (
          <>
            <p>This run has cost ${Number(p.run_cost_usd ?? 0).toFixed(2)} (cap ${Number(p.cap_usd ?? 0).toFixed(2)}).</p>
            {card.status === 'pending' && (
              <>
                <button type="button" disabled={busy} onClick={() => decide('continue')}>Continue</button>{' '}
                <button type="button" disabled={busy} onClick={() => decide('stop')}>Stop</button>
              </>
            )}
          </>
        )}

        {card.kind === 'document' && (
          <p>
            {p.name || 'Estimate'}{' '}
            {p.document_id && (
              <>
                <a href={`/api/documents/${p.document_id}/download`}>Download</a>{' '}
                <a href={`?doc=${p.document_id}`}>View</a>
              </>
            )}
            {p.totals && <> — totals: {JSON.stringify(p.totals)}</>}
          </p>
        )}

        {card.kind === 'web_prices' && (
          <ul>
            {(p.items || p.prices || []).map((w: any, i: number) => (
              <li key={i}>
                {w.product || w.query}: {w.unit_price} {w.currency} {w.url && <a href={w.url} target="_blank" rel="noreferrer">source</a>}
              </li>
            ))}
          </ul>
        )}

        {msg && <p role="alert">{msg}</p>}
      </fieldset>
    </section>
  );
}
