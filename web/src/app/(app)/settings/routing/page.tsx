'use client';

/** design/settings-routing.dc.html, DESIGN.md §4.10. Admins edit (changes save right away); estimators read. */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { SettingsFrame } from '@/components/SettingsNav';
import { useUser } from '@/components/UserContext';
import { MONO } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { money, TIER_LABEL } from '../format';

type Tier = 'fast' | 'standard' | 'advanced';
const ORDER: Tier[] = ['fast', 'standard', 'advanced'];
interface Routing {
  tiers: Record<Tier, { model_id: string; enabled: boolean }>;
  tasks: Record<string, Tier>;
  overrides: Record<string, Tier>;
  escalate_when_unsure: boolean;
}
interface Price { input: number; output: number; cache_read: number; cache_write: number }
interface Prices { models: Record<string, Price>; web_search_unit_usd: number }
interface Resp { routing: Routing; prices: Prices; defaults?: { tasks: Record<string, Tier> }; spend_month?: { tiers: Record<string, number>; tasks: Record<string, number> } }

/** Plain-language task names (design wording); unknown tasks fall back to a readable form of their key. */
const TASK_LABEL: Record<string, string> = {
  simple_question: 'Simple questions about an estimate',
  short_reply: 'Short replies and confirmations',
  email: 'Sending estimates by email',
  classify: 'Working out what a message asks for',
  file_analysis: 'Analysing files for the knowledge base',
  fill_blank: 'Filling a blank with prices',
  web_search: 'Searching supplier websites',
  generate: 'Generating an estimate from a work list',
  complex_reasoning: 'Complex reasoning across many rows',
};
const taskLabel = (k: string) => TASK_LABEL[k] ?? k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
/** "eu.anthropic.claude-haiku-4-5-20251001-v1:0" → "Claude Haiku 4.5"; other ids are shown as they are. */
function modelName(id: string): string {
  const m = /claude-(?:(\d+)-(\d+)-)?(haiku|sonnet|opus)(?:-(\d+)(?:-(\d{1,2})(?=-|$|:))?)?/i.exec(id);
  if (!m) return id;
  const fam = m[3][0].toUpperCase() + m[3].slice(1).toLowerCase();
  const ver = m[1] ? `${m[1]}${m[2] ? '.' + m[2] : ''}` : m[4] ? `${m[4]}${m[5] ? '.' + m[5] : ''}` : '';
  return `Claude ${fam}${ver ? ' ' + ver : ''}`;
}
const fmtPrice = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, '')}`;
const arrow = (
  <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
    <div style={{ flex: 1, height: 1.5, background: 'var(--ink3)' }} /><span style={{ color: 'var(--ink3)', marginLeft: -4, fontSize: 12 }}>▶</span>
  </div>
);
const small: CSSProperties = { height: 32, padding: '0 8px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 13 };

export default function RoutingPage() {
  const user = useUser();
  const admin = user.role === 'admin';
  const [data, setData] = useState<Resp | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<Tier | null>(null);
  const [draft, setDraft] = useState<{ model_id: string; input: string; output: string }>({ model_id: '', input: '', output: '' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Resp>('/api/settings/routing').then(setData).catch((e) => setError(e.message || 'Could not load routing.'));
  }, []);

  /** Saves right away (design: "Changes apply to new messages right away"); reverts on failure. */
  const save = useCallback(async (next: { routing?: Routing; prices?: Prices }, okText = 'Saved. Applies to new messages.') => {
    if (!data || !admin) return;
    const prev = data;
    setData({ ...data, ...next });
    setMsg(null);
    try {
      const r = await api<Resp>('/api/settings/routing', { method: 'PUT', json: next });
      setData(r);
      setMsg({ ok: true, text: okText });
    } catch (e) {
      setData(prev);
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not save.' });
    }
  }, [data, admin]);

  if (error) return <SettingsFrame maxWidth={1160}><h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Model routing</h1><span style={{ color: 'var(--err)', fontSize: 14 }}>{error}</span></SettingsFrame>;
  if (!data) return <SettingsFrame maxWidth={1160}><h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Model routing</h1><span style={{ color: 'var(--ink3)', fontSize: 14 }}>Loading…</span></SettingsFrame>;

  const { routing, prices } = data;
  const defaults = data.defaults?.tasks ?? routing.tasks;
  const tasks = Array.from(new Set([...Object.keys(defaults), ...Object.keys(routing.tasks)]));
  const defOf = (t: string): Tier => routing.tasks[t] ?? defaults[t] ?? 'standard';
  const wanted = (t: string): Tier => routing.overrides?.[t] ?? defOf(t);
  /** Same rule as the worker's router: a disabled tier sends its tasks up (or down if nothing above is on). */
  const target = (t: string): Tier => {
    const w = wanted(t);
    if (routing.tiers[w]?.enabled !== false) return w;
    const i = ORDER.indexOf(w);
    return ORDER.slice(i + 1).find((x) => routing.tiers[x].enabled) ?? [...ORDER.slice(0, i)].reverse().find((x) => routing.tiers[x].enabled) ?? w;
  };
  const spend = data.spend_month ?? { tiers: {}, tasks: {} };

  const setRouting = (r: Routing, text?: string) => save({ routing: r }, text);
  const toggleTier = (t: Tier) => {
    if (t === 'advanced') return; // the strongest tier stays on (design)
    setRouting({ ...routing, tiers: { ...routing.tiers, [t]: { ...routing.tiers[t], enabled: !routing.tiers[t].enabled } } });
  };
  const setOverride = (task: string, v: string) => {
    const o = { ...(routing.overrides || {}) };
    if (v && v !== defOf(task)) o[task] = v as Tier;
    else delete o[task];
    setRouting({ ...routing, overrides: o });
  };
  const reset = () => setRouting({
    ...routing,
    tasks: { ...routing.tasks, ...defaults },
    overrides: {},
    escalate_when_unsure: true,
    tiers: { fast: { ...routing.tiers.fast, enabled: true }, standard: { ...routing.tiers.standard, enabled: true }, advanced: { ...routing.tiers.advanced, enabled: true } },
  }, 'Reset to defaults.');

  const startEdit = (t: Tier) => {
    const id = routing.tiers[t].model_id;
    const p = prices.models[id];
    setDraft({ model_id: id, input: String(p?.input ?? ''), output: String(p?.output ?? '') });
    setEditing(t);
  };
  const saveEdit = async () => {
    if (!editing) return;
    const id = draft.model_id.trim();
    const input = Number(draft.input), output = Number(draft.output);
    if (!id) return setMsg({ ok: false, text: 'Enter a model id.' });
    if (!(input >= 0) || !(output >= 0) || draft.input === '' || draft.output === '') return setMsg({ ok: false, text: 'Enter both prices in dollars per 1M tokens.' });
    const old = prices.models[id] ?? prices.models[routing.tiers[editing].model_id];
    // Cache prices follow the usual ratios (read 10%, write 125% of input) unless they were already set for this model.
    const price: Price = { input, output, cache_read: prices.models[id]?.cache_read ?? old?.cache_read ?? +(input * 0.1).toFixed(4), cache_write: prices.models[id]?.cache_write ?? old?.cache_write ?? +(input * 1.25).toFixed(4) };
    await save({
      routing: { ...routing, tiers: { ...routing.tiers, [editing]: { ...routing.tiers[editing], model_id: id } } },
      prices: { ...prices, models: { ...prices.models, [id]: price } },
    });
    setEditing(null);
  };

  return (
    <SettingsFrame maxWidth={1160}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Model routing</h1>
        <span style={{ fontSize: 14, color: 'var(--ink2)' }}>Every request goes to the cheapest model that can do the job well. Simple questions are cheap; building an estimate needs the strongest model.</span>
        {!admin && <span style={{ fontSize: 13, color: 'var(--ink3)', marginTop: 4 }}>Only admins can change routing.</span>}
      </div>

      <div style={{ padding: 20, border: '1px solid var(--line)', borderRadius: 16, background: 'var(--panel)', overflowX: 'auto' }}>
        <div style={{ minWidth: 760, display: 'grid', gridTemplateColumns: '170px 48px 190px 48px minmax(0,1fr)', alignItems: 'stretch' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8, padding: 14, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--side)' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink3)' }}>1 · Incoming request</span>
              <span style={{ fontSize: 13, color: 'var(--ink2)', lineHeight: 1.5 }}>A message, an uploaded file, a blank or a work list</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center' }}>{arrow}</div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, padding: 14, border: '1.5px solid var(--acc)', borderRadius: 12, background: 'var(--accSoft)' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accInk)' }}>2 · Router</span>
              <span style={{ fontSize: 13, lineHeight: 1.5 }}>Looks at the task type and picks a tier.</span>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, lineHeight: 1.4, cursor: admin ? 'pointer' : 'default' }}>
                <input type="checkbox" checked={routing.escalate_when_unsure} disabled={!admin}
                  onChange={() => setRouting({ ...routing, escalate_when_unsure: !routing.escalate_when_unsure })}
                  style={{ accentColor: 'var(--acc)', marginTop: 2 }} />
                Move up a tier when the agent is unsure
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
            <div style={{ position: 'absolute', right: 0, top: '16.66%', bottom: '16.66%', width: 1.5, background: 'var(--ink3)' }} />
            <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}><div style={{ flex: 1, height: 1.5, background: 'var(--ink3)' }} /></div>
            <div style={{ flex: 1 }} /><div style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {ORDER.map((t) => {
              const cfg = routing.tiers[t];
              const on = cfg.enabled !== false;
              const p = prices.models[cfg.model_id];
              const mine = tasks.filter((k) => target(k) === t);
              return (
                <div key={t} style={{ display: 'flex', alignItems: 'stretch', opacity: on ? 1 : 0.55 }}>
                  <div style={{ width: 28, flex: 'none', display: 'flex', alignItems: 'center' }}>{arrow}</div>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--panel)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>{TIER_LABEL[t]}</span>
                      <span style={{ fontSize: 12.5, color: 'var(--ink3)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }} title={cfg.model_id}>{modelName(cfg.model_id)}</span>
                      {admin && editing !== t && (
                        <button type="button" onClick={() => startEdit(t)} className="hv-under"
                          style={{ border: 0, background: 'transparent', padding: 0, color: 'var(--accInk)', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}>Edit</button>
                      )}
                      <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 12, color: 'var(--ink2)' }}>
                        {p ? `${fmtPrice(p.input)} in · ${fmtPrice(p.output)} out / 1M tokens` : 'No price set'}
                      </span>
                      <button type="button" role="switch" aria-checked={on} aria-label={`${TIER_LABEL[t]} tier`}
                        disabled={!admin || t === 'advanced'} onClick={() => toggleTier(t)}
                        title={t === 'advanced' ? 'The strongest tier always stays on' : undefined}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, font: 'inherit', fontSize: 12.5, color: 'var(--ink2)', border: 0, background: 'transparent', padding: 0, cursor: admin && t !== 'advanced' ? 'pointer' : 'default' }}>
                        <span style={{ width: 32, height: 18, borderRadius: 9, background: on ? 'var(--acc)' : 'var(--line)', position: 'relative', display: 'inline-block' }}>
                          <span style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 14, height: 14, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
                        </span>
                        {on ? 'On' : 'Off'}
                      </button>
                    </div>
                    {editing === t && (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', padding: 10, borderRadius: 10, background: 'var(--side)' }}>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 500, flex: '1 1 260px' }}>Model id
                          <input value={draft.model_id} onChange={(e) => setDraft({ ...draft, model_id: e.target.value })} style={{ ...small, fontFamily: MONO, fontSize: 12 }} />
                        </label>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 500, width: 110 }}>$ in / 1M
                          <input inputMode="decimal" value={draft.input} onChange={(e) => setDraft({ ...draft, input: e.target.value.replace(/[^\d.]/g, '') })} style={{ ...small, fontFamily: MONO }} />
                        </label>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 500, width: 110 }}>$ out / 1M
                          <input inputMode="decimal" value={draft.output} onChange={(e) => setDraft({ ...draft, output: e.target.value.replace(/[^\d.]/g, '') })} style={{ ...small, fontFamily: MONO }} />
                        </label>
                        <button type="button" onClick={saveEdit} style={{ height: 32, padding: '0 12px', border: 0, borderRadius: 8, background: 'var(--acc)', color: '#fff', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Save</button>
                        <button type="button" onClick={() => setEditing(null)} style={{ height: 32, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
                      </div>
                    )}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {mine.map((k) => {
                        const moved = !!routing.overrides?.[k] || target(k) !== defOf(k);
                        return (
                          <span key={k} style={{ height: 26, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 10px', borderRadius: 13, background: moved ? 'var(--accSoft)' : 'var(--sunk)', color: moved ? 'var(--accInk)' : 'var(--ink)', fontSize: 12.5 }}>
                            {taskLabel(k)}{moved && <span style={{ fontSize: 10.5, fontWeight: 600 }}>OVERRIDE</span>}
                          </span>
                        );
                      })}
                      {mine.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--ink3)' }}>{on ? 'No tasks routed here' : 'Off. Its tasks go to the next tier up.'}</span>}
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--ink3)' }}>This month: {money(spend.tiers[t] ?? 0)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Per-task overrides</span>
          <span style={{ fontSize: 13, color: 'var(--ink3)' }}>Change where a task goes. The diagram updates.</span>
        </div>
        <div style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)', overflowX: 'auto' }}>
          <div style={{ minWidth: 600 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px,1fr) 110px 170px 90px', fontSize: 12, fontWeight: 600, color: 'var(--ink2)', borderBottom: '1px solid var(--line)' }}>
              <div style={{ padding: '10px 16px' }}>Task</div><div style={{ padding: '10px 8px' }}>Default</div><div style={{ padding: '10px 8px' }}>Send to</div><div style={{ padding: '10px 16px 10px 8px', textAlign: 'right' }}>This month</div>
            </div>
            {tasks.map((k) => {
              const ov = routing.overrides?.[k];
              return (
                <div key={k} style={{ display: 'grid', gridTemplateColumns: 'minmax(220px,1fr) 110px 170px 90px', alignItems: 'center', borderBottom: '1px solid var(--line2)', fontSize: 13.5, background: ov ? 'var(--side)' : 'transparent' }}>
                  <div style={{ padding: '8px 16px' }}>{taskLabel(k)}</div>
                  <div style={{ padding: 8, color: 'var(--ink2)' }}>{TIER_LABEL[defOf(k)]}</div>
                  <div style={{ padding: '6px 8px' }}>
                    <select aria-label={`Send ${taskLabel(k)} to`} value={ov ?? ''} disabled={!admin} onChange={(e) => setOverride(k, e.target.value)}
                      style={{ ...small, width: '100%', border: `1px solid ${ov ? 'var(--acc)' : 'var(--line)'}` }}>
                      <option value="">Default ({TIER_LABEL[defOf(k)]})</option>
                      {ORDER.map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
                    </select>
                  </div>
                  <div style={{ padding: '8px 16px 8px 8px', textAlign: 'right', fontFamily: MONO, fontSize: 12.5, color: 'var(--ink2)' }}>{money(spend.tasks[k] ?? 0)}</div>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {admin && (
            <button type="button" onClick={reset} className="hv-sunk"
              style={{ height: 34, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--panel)', color: 'var(--ink)', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>Reset to defaults</button>
          )}
          <span role="status" style={{ fontSize: 12.5, color: msg ? (msg.ok ? 'var(--ok)' : 'var(--err)') : 'var(--ink3)' }}>
            {msg ? msg.text : 'Changes apply to new messages right away.'}
          </span>
        </div>
      </div>
    </SettingsFrame>
  );
}
