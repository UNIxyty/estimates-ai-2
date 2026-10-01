'use client';

/** design/settings-usage.dc.html, DESIGN.md §4.9. */
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { SettingsFrame } from '@/components/SettingsNav';
import { useUser } from '@/components/UserContext';
import { initials, MONO } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { budgetAmount, money } from '../format';
import css from '../settings.module.css';

interface Win { cost_usd: number; messages: number; conversations: number }
interface Day { day: string; fast: number; standard: number; advanced: number; other: number; total: number }
interface TierRow { tier: string; calls: number; cost_usd: number }
interface Usage {
  days: number;
  scope: 'all' | 'mine';
  daily: Day[];
  tiers: TierRow[];
  top_conversations: { id: string; title: string; user_name?: string | null; user_email?: string | null; cost_usd: number }[];
  windows: { today: Win; week: Win; month: Win };
  conversations_by_tier: { id: string; title: string; messages: number; fast: number; standard: number; advanced: number; other: number; total: number }[];
}
interface Budget { monthly_usd: number; alert_pct: number; over_action: 'pause' | 'fast_only' | 'warn' }
interface Status { spent_usd: number; amount_usd: number; alert_pct: number; action: Budget['over_action']; state: 'ok' | 'near' | 'over' }

const card: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)' };
const h2: CSSProperties = { fontSize: 14.5, fontWeight: 600 };
const field: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 500 };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`; };
/** Bar segments, top to bottom. "Other" = embeddings and web search, which have no model tier. */
const SEGS: { k: 'advanced' | 'standard' | 'fast' | 'other'; label: string; op: number; bg: string }[] = [
  { k: 'advanced', label: 'Advanced', op: 1, bg: 'var(--acc)' },
  { k: 'standard', label: 'Standard', op: 0.55, bg: 'var(--acc)' },
  { k: 'fast', label: 'Fast', op: 0.25, bg: 'var(--acc)' },
  { k: 'other', label: 'Other', op: 0.45, bg: 'var(--ink3)' },
];
const plural = (n: number, w: string) => `${Number(n || 0).toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
const COLS = 'minmax(200px,1fr) 70px 70px 80px 80px 70px 80px';

export default function UsagePage() {
  const user = useUser();
  const admin = user.role === 'admin';
  const [d, setD] = useState<Usage | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [budget, setBudget] = useState<{ amount: string; thr: number; out: Budget['over_action'] } | null>(null);
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const budgetRef = useRef<HTMLDivElement>(null);

  const loadStatus = useCallback(() => { api<Status>('/api/budget/status').then(setStatus).catch(() => {}); }, []);
  useEffect(() => {
    api<Usage>('/api/usage?days=30').then(setD).catch((e) => setError(e.message || 'Could not load usage.'));
    api<{ budget: Budget }>('/api/settings/budget')
      .then((r) => setBudget({ amount: String(r.budget.monthly_usd ?? 0), thr: r.budget.alert_pct ?? 80, out: r.budget.over_action ?? 'warn' }))
      .catch(() => {});
    loadStatus();
  }, [loadStatus]);

  const focusBudget = () => {
    const el = budgetRef.current;
    const main = el?.closest('main');
    if (el && main) main.scrollTo({ top: el.offsetTop - 20, behavior: 'smooth' });
    setFlash(true);
    setTimeout(() => setFlash(false), 1200);
  };

  async function save() {
    if (!budget) return;
    const amount = Number(budget.amount || 0);
    if (!Number.isFinite(amount) || amount < 0) return setSaved({ ok: false, text: 'Enter an amount in dollars.' });
    setSaving(true);
    setSaved(null);
    try {
      await api('/api/settings/budget', { method: 'PUT', json: { monthly_usd: amount, alert_pct: budget.thr, over_action: budget.out } });
      setSaved({ ok: true, text: 'Saved. Applies immediately.' });
      loadStatus();
    } catch (e) {
      setSaved({ ok: false, text: e instanceof ApiError ? e.message : 'Could not save the budget.' });
    } finally {
      setSaving(false);
    }
  }

  const now = new Date();
  const monthName = MONTHS[now.getUTCMonth()];
  const nextMonth = MONTHS[(now.getUTCMonth() + 1) % 12];
  const amount = Number(status?.amount_usd ?? 0);
  const spent = Number(status?.spent_usd ?? 0);
  const pct = amount > 0 ? Math.round((spent / amount) * 100) : 0;
  const barC = status?.state === 'over' ? 'var(--err)' : status?.state === 'near' ? 'var(--warn)' : 'var(--acc)';

  // Projected date the limit is reached, from this month's pace so far.
  let projection = '';
  if (status?.state === 'near' && amount > 0 && spent > 0) {
    const elapsed = now.getUTCDate() - 1 + (now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440;
    const perDay = spent / Math.max(elapsed, 0.25);
    const at = new Date(now.getTime() + ((amount - spent) / perDay) * 86400000);
    projection = at.getUTCMonth() === now.getUTCMonth() && at.getUTCFullYear() === now.getUTCFullYear()
      ? ` At this pace you'll reach the limit around ${at.getUTCDate()} ${monthName}.`
      : ` At this pace you'll stay under the limit this month.`;
  }

  const w = d?.windows;
  const kpis = w ? [
    { label: 'Today', v: money(w.today.cost_usd), sub: `${plural(w.today.messages, 'message')} · ${plural(w.today.conversations, 'conversation')}`, bar: false },
    { label: 'This week', v: money(w.week.cost_usd), sub: `${plural(w.week.messages, 'message')} · ${plural(w.week.conversations, 'conversation')}`, bar: false },
    {
      label: 'This month', v: money(w.month.cost_usd), bar: amount > 0,
      sub: amount <= 0 ? `${plural(w.month.messages, 'message')} · no monthly budget set`
        : admin ? `of ${budgetAmount(amount)} budget · ${pct}%` : `Company: ${money(spent)} of ${budgetAmount(amount)} budget · ${pct}%`,
    },
  ] : [];

  const days = d?.daily ?? [];
  const periodTotal = days.reduce((a, x) => a + x.total, 0);
  const max = Math.max(0, ...days.map((x) => x.total)) * 1.1;
  const avg = days.length ? periodTotal / days.length : 0;
  const h = (v: number) => (max > 0 ? (v / max) * 100 : 0);
  const hd = hover !== null ? days[hover] : null;
  const tip = hd
    ? `${SHORT(hd.day)}: ${money(hd.total)}${hd.total > 0 ? ' · ' + SEGS.filter((sg) => hd[sg.k] > 0).map((sg) => `${sg.label} ${money(hd[sg.k])}`).join(', ') : ''}`
    : 'Hover a day to see its total';
  const ticks = days.length ? Array.from(new Set([0, 7, 14, 21, days.length - 1])).filter((i) => i < days.length) : [];

  const tierCost = (k: string) => Number(d?.tiers.find((t) => t.tier === k)?.cost_usd ?? 0);
  const tierCalls = (k: string) => Number(d?.tiers.find((t) => t.tier === k)?.calls ?? 0);
  const tierTotal = d ? d.tiers.reduce((a, t) => a + Number(t.cost_usd), 0) : 0;
  const tierRows = ([
    ['advanced', 'Advanced', 1], ['standard', 'Standard', 0.55], ['fast', 'Fast', 0.25], ['other', 'Other', 0.45],
  ] as [string, string, number][]).filter(([k]) => k !== 'other' || tierCost('other') > 0 || tierCalls('other') > 0);

  const convs = d?.conversations_by_tier ?? [];

  return (
    <SettingsFrame maxWidth={1120}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Usage &amp; costs</h1>
          <span style={{ fontSize: 14, color: 'var(--ink2)' }}>
            {d?.scope === 'mine' ? 'What your conversations cost to run.' : 'What the agent costs to run, for the whole company.'} {monthName} {now.getUTCFullYear()}.
          </span>
        </div>
      </div>

      {status?.state === 'near' && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: '1px solid var(--warn)', borderRadius: 12, background: 'var(--warnSoft)', fontSize: 14, flexWrap: 'wrap' }}>
          <span style={{ width: 20, height: 20, flex: 'none', borderRadius: '50%', background: 'var(--warn)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>!</span>
          <span style={{ flex: 1, minWidth: 240 }}><b style={{ fontWeight: 600 }}>{pct}% of this month&apos;s budget is used</b> ({money(spent)} of {budgetAmount(amount)}).{projection}</span>
          {admin && <button type="button" onClick={focusBudget} style={{ height: 32, padding: '0 12px', border: '1px solid var(--warn)', borderRadius: 8, background: 'var(--panel)', color: 'var(--warn)', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Adjust budget</button>}
        </div>
      )}
      {status?.state === 'over' && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: '1px solid var(--err)', borderRadius: 12, background: 'var(--errSoft)', fontSize: 14, flexWrap: 'wrap' }}>
          <span style={{ width: 20, height: 20, flex: 'none', borderRadius: '50%', background: 'var(--err)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>!</span>
          <span style={{ flex: 1, minWidth: 240 }}>
            {status.action === 'pause' ? (
              <><b style={{ fontWeight: 600 }}>Budget exceeded. New requests are paused.</b> {money(spent)} of {budgetAmount(amount)} used. Estimators can still open and download estimates. Requests resume on 1 {nextMonth}, or now if you raise the budget.</>
            ) : status.action === 'fast_only' ? (
              <><b style={{ fontWeight: 600 }}>Budget exceeded. Only the Fast tier is used.</b> {money(spent)} of {budgetAmount(amount)} used. Normal routing resumes on 1 {nextMonth}, or now if you raise the budget.</>
            ) : (
              <><b style={{ fontWeight: 600 }}>Budget exceeded.</b> {money(spent)} of {budgetAmount(amount)} used. Requests keep working; this is only a warning. The budget resets on 1 {nextMonth}.</>
            )}
          </span>
          {admin && <button type="button" onClick={focusBudget} style={{ height: 32, padding: '0 12px', border: 0, borderRadius: 8, background: 'var(--err)', color: '#fff', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Raise budget</button>}
        </div>
      )}

      {error && <div style={{ ...card, color: 'var(--err)', fontSize: 14 }}>{error}</div>}
      {!d && !error && <div style={{ ...card, color: 'var(--ink3)', fontSize: 14 }}>Loading…</div>}

      {d && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
            {kpis.map((k) => (
              <div key={k.label} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 16, border: '1px solid var(--line)', borderRadius: 14, background: 'var(--panel)' }}>
                <span style={{ fontSize: 12.5, color: 'var(--ink3)' }}>{k.label}</span>
                <span style={{ fontFamily: MONO, fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em' }}>{k.v}</span>
                <span style={{ fontSize: 12.5, color: 'var(--ink2)' }}>{k.sub}</span>
                {k.bar && <div style={{ height: 6, borderRadius: 3, background: 'var(--sunk)', overflow: 'hidden', marginTop: 4 }}><div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: barC }} /></div>}
              </div>
            ))}
          </div>

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={h2}>Daily spend</span>
              <span style={{ fontSize: 12.5, color: 'var(--ink3)' }}>{tip}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, fontSize: 12, color: 'var(--ink2)', flexWrap: 'wrap' }}>
                {SEGS.filter((sg) => sg.k !== 'other' || days.some((x) => x.other > 0)).map((sg) => (
                  <span key={sg.k} style={{ display: 'flex', alignItems: 'center', gap: 5 }} title={sg.k === 'other' ? 'Embeddings and web search' : undefined}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: sg.bg, opacity: sg.op }} />{sg.label}
                  </span>
                ))}
              </span>
            </div>
            <div onMouseLeave={() => setHover(null)} style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 180, paddingTop: 8, borderBottom: '1px solid var(--line)', position: 'relative' }}>
              {max > 0 && <div style={{ position: 'absolute', left: 0, right: 0, bottom: `${h(avg)}%`, borderTop: '1px dashed var(--ink3)', opacity: 0.6, pointerEvents: 'none' }} />}
              {max === 0 && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--ink3)' }}>No spend in the last {d.days} days.</div>}
              {days.map((x, i) => (
                <div key={x.day} onMouseEnter={() => setHover(i)} aria-label={`${SHORT(x.day)}: ${money(x.total)}`}
                  style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', cursor: 'default', opacity: hover === null || hover === i ? 1 : 0.5 }}>
                  {SEGS.map((sg, j) => {
                    const v = x[sg.k];
                    if (!(v > 0)) return null;
                    const top = SEGS.slice(0, j).every((p) => !(x[p.k] > 0));
                    return <div key={sg.k} style={{ height: `${Math.max(h(v), 0.8)}%`, background: sg.bg, opacity: sg.op, borderRadius: top ? '2px 2px 0 0' : 0 }} />;
                  })}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--ink3)', fontFamily: MONO }}>
              {ticks.map((i) => <span key={i}>{SHORT(days[i].day)}</span>)}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink3)' }}>Last {d.days} days. Dashed line: daily average ({money(avg)}).</div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12 }}>
            <div style={card}>
              <span style={h2}>By model tier</span>
              <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', gap: 2, background: tierTotal > 0 ? 'transparent' : 'var(--sunk)' }}>
                {tierTotal > 0 && [...tierRows].reverse().map(([k, , op]) => {
                  const c = tierCost(k);
                  return c > 0 ? <div key={k} style={{ width: `${(c / tierTotal) * 100}%`, background: k === 'other' ? 'var(--ink3)' : 'var(--acc)', opacity: op }} /> : null;
                })}
              </div>
              <div>
                {tierRows.map(([k, name]) => (
                  <div key={k} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, alignItems: 'baseline', padding: '6px 0', borderBottom: '1px solid var(--line2)', fontSize: 13.5 }}>
                    <span><b style={{ fontWeight: 600 }}>{name}</b> <span style={{ color: 'var(--ink3)', fontSize: 12.5 }}>{plural(tierCalls(k), 'call')}{k === 'other' ? ' · embeddings, web search' : ''}</span></span>
                    <span style={{ color: 'var(--ink3)', fontSize: 12.5 }}>{tierTotal > 0 ? `${Math.round((tierCost(k) / tierTotal) * 100)}%` : '—'}</span>
                    <span style={{ fontFamily: MONO }}>{money(tierCost(k))}</span>
                  </div>
                ))}
              </div>
              <span style={{ fontSize: 12, color: 'var(--ink3)' }}>Last {d.days} days.</span>
              <Link href="/settings/routing" style={{ fontSize: 13, fontWeight: 500 }}>Change which tasks use which tier ›</Link>
            </div>
            <div style={{ ...card, gap: 6 }}>
              <span style={{ ...h2, marginBottom: 6 }}>Most expensive conversations</span>
              {d.top_conversations.length === 0 && <span style={{ fontSize: 13, color: 'var(--ink3)' }}>No conversations with AI costs in the last {d.days} days.</span>}
              {d.top_conversations.map((c) => (
                <Link key={c.id} href={`/chat/${c.id}`} className={css.accInk}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', gap: 10, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--line2)', textDecoration: 'none', color: 'var(--ink)', fontSize: 13.5 }}>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
                  <span style={{ fontSize: 12, color: 'var(--ink3)' }} title={d.scope === 'all' ? (c.user_name || c.user_email || '') : undefined}>{d.scope === 'all' ? initials(c.user_name, c.user_email) : ''}</span>
                  <span style={{ fontFamily: MONO, minWidth: 52, textAlign: 'right' }}>{money(c.cost_usd)}</span>
                </Link>
              ))}
            </div>
          </div>

          <div style={{ ...card, gap: 8 }}>
            <span style={h2}>By conversation, last {d.days} days</span>
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 640 }}>
                <div style={{ display: 'grid', gridTemplateColumns: COLS, fontSize: 12, fontWeight: 600, color: 'var(--ink2)', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ padding: '8px 0' }}>Conversation</div>
                  {['Msgs', 'Fast', 'Standard', 'Advanced', 'Other'].map((x) => <div key={x} style={{ padding: 8, textAlign: 'right' }} title={x === 'Other' ? 'Embeddings and web search' : undefined}>{x}</div>)}
                  <div style={{ padding: '8px 0 8px 8px', textAlign: 'right' }}>Total</div>
                </div>
                {convs.length === 0 && <div style={{ padding: '14px 0', fontSize: 13, color: 'var(--ink3)' }}>No conversation has used the agent in the last {d.days} days.</div>}
                {convs.map((c) => (
                  <div key={c.id} style={{ display: 'grid', gridTemplateColumns: COLS, fontSize: 13, borderBottom: '1px solid var(--line2)', fontVariantNumeric: 'tabular-nums' }}>
                    <div style={{ padding: '8px 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <Link href={`/chat/${c.id}`} className={css.accInk} style={{ color: 'var(--ink)', textDecoration: 'none' }}>{c.title}</Link>
                    </div>
                    <div style={{ padding: 8, textAlign: 'right', color: 'var(--ink2)' }}>{c.messages}</div>
                    {[c.fast, c.standard, c.advanced, c.other].map((v, i) => <div key={i} style={{ padding: 8, textAlign: 'right', fontFamily: MONO, fontSize: 12, color: 'var(--ink2)' }}>{money(v)}</div>)}
                    <div style={{ padding: '8px 0 8px 8px', textAlign: 'right', fontFamily: MONO, fontSize: 12, fontWeight: 600 }}>{money(c.total)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {budget && (
        <div ref={budgetRef} className={css.flash} style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 18, border: `1px solid ${flash ? 'var(--acc)' : 'var(--line)'}`, borderRadius: 14, background: 'var(--panel)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={h2}>Monthly budget</span>
            <span style={{ fontSize: 13, color: 'var(--ink2)' }}>Applies to the whole company. Resets on the 1st.{!admin && ' Only admins can change it.'}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16 }}>
            <label style={field}>Budget per month
              <span style={{ display: 'flex', alignItems: 'center', height: 40, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)', padding: '0 12px', gap: 6, opacity: admin ? 1 : 0.7 }}>
                <span style={{ color: 'var(--ink3)' }}>$</span>
                <input inputMode="decimal" value={budget.amount} disabled={!admin} title="0 means no budget"
                  onChange={(e) => { setBudget({ ...budget, amount: e.target.value.replace(/[^\d.]/g, '') }); setSaved(null); }}
                  style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--ink)', fontFamily: MONO, fontSize: 14 }} />
              </span>
            </label>
            <label style={field}>
              <span>Warn at <b style={{ fontFamily: MONO }}>{budget.thr}%</b></span>
              <input type="range" min={50} max={100} step={5} value={budget.thr} disabled={!admin}
                onChange={(e) => { setBudget({ ...budget, thr: Number(e.target.value) }); setSaved(null); }}
                style={{ accentColor: 'var(--acc)', height: 40 }} />
            </label>
            <label style={field}>When the budget runs out
              <select value={budget.out} disabled={!admin} onChange={(e) => { setBudget({ ...budget, out: e.target.value as Budget['over_action'] }); setSaved(null); }}
                style={{ height: 40, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 13.5 }}>
                <option value="pause">Pause all new requests</option>
                <option value="fast_only">Allow Fast tier only</option>
                <option value="warn">Keep working, only warn</option>
              </select>
            </label>
          </div>
          {admin && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button type="button" onClick={save} disabled={saving}
                style={{ height: 38, padding: '0 16px', border: 0, borderRadius: 10, background: 'var(--acc)', color: '#fff', font: 'inherit', fontWeight: 600, fontSize: 13.5, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>Save budget</button>
              {saved && <span role="status" style={{ fontSize: 13, color: saved.ok ? 'var(--ok)' : 'var(--err)' }}>{saved.text}</span>}
            </div>
          )}
        </div>
      )}
    </SettingsFrame>
  );
}
