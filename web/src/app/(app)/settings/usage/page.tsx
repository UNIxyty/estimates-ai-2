'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { DesignPending } from '@/components/DesignPending';
import { api, usd, when } from '@/lib/client';

export default function UsagePage() {
  const [days, setDays] = useState(30);
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    api(`/api/usage?days=${days}`).then(setD).catch(() => {});
  }, [days]);
  return (
    <section>
      <DesignPending />
      <h1>Usage</h1>
      <p>
        <label>
          Period{' '}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90].map((n) => <option key={n} value={n}>Last {n} days</option>)}
          </select>
        </label>
      </p>
      {!d ? (
        <p>Loading…</p>
      ) : (
        <>
          <p>Scope: {d.scope === 'all' ? 'everyone' : 'your conversations'}</p>
          <dl>
            <dt>Spend this month</dt><dd>{usd(d.kpis.spend_month_usd)}</dd>
            <dt>Spend last {d.days} days</dt><dd>{usd(d.kpis.spend_period_usd)}</dd>
            <dt>Runs</dt><dd>{d.kpis.runs}</dd>
            <dt>Average cost per question</dt><dd>{usd(d.kpis.avg_cost_per_question_usd, 4)} ({d.kpis.questions} answers)</dd>
            <dt>Share by tier</dt>
            <dd>{Object.entries(d.kpis.tier_share).map(([t, s]) => `${t} ${Math.round(Number(s) * 100)}%`).join(' · ') || '—'}</dd>
          </dl>

          <h2>Daily spend by tier</h2>
          <table>
            <thead><tr><th>Day</th><th>Fast</th><th>Standard</th><th>Advanced</th><th>Other</th><th>Total</th></tr></thead>
            <tbody>
              {d.daily.map((r: any) => (
                <tr key={r.day}>
                  <td>{r.day}</td><td>{usd(r.fast, 4)}</td><td>{usd(r.standard, 4)}</td><td>{usd(r.advanced, 4)}</td><td>{usd(r.other, 4)}</td><td>{usd(r.total, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>By tier</h2>
          <table>
            <thead><tr><th>Tier</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead>
            <tbody>
              {d.tiers.map((t: any) => <tr key={t.tier}><td>{t.tier}</td><td>{t.calls}</td><td>{t.tokens}</td><td>{usd(t.cost_usd, 4)}</td></tr>)}
            </tbody>
          </table>

          <h2>Most expensive conversations</h2>
          <ol>
            {d.top_conversations.map((c: any) => (
              <li key={c.id}>{c.title} — {usd(c.cost_usd, 4)}{d.scope === 'all' && c.user_name ? ` (${c.user_name})` : ''}</li>
            ))}
          </ol>

          <h2>Conversations</h2>
          <table>
            <thead>
              <tr><th>Title</th>{d.scope === 'all' && <th>User</th>}<th>Runs</th><th>Tokens</th><th>Cost</th><th>Last activity</th></tr>
            </thead>
            <tbody>
              {d.conversations.map((c: any) => (
                <tr key={c.id}>
                  <td>{c.user_id === undefined ? c.title : <Link href={`/chat/${c.id}`}>{c.title}</Link>}</td>
                  {d.scope === 'all' && <td>{c.user_name || c.user_email}</td>}
                  <td>{c.runs}</td><td>{c.tokens}</td><td>{usd(c.cost_usd, 4)}</td><td>{when(c.last_activity_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
