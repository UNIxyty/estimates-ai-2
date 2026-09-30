'use client';

import { useEffect, useState } from 'react';
import { DesignPending } from '@/components/DesignPending';
import { useUser } from '@/components/UserContext';
import { api, ApiError, usd } from '@/lib/client';

/** Routing (tiers/task map/overrides/escalation), prices and budget. Editable by admins only. */
export default function RoutingPage() {
  const user = useUser();
  const admin = user.role === 'admin';
  const [routing, setRouting] = useState<any>(null);
  const [prices, setPrices] = useState<string>('');
  const [budget, setBudget] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => {
    api('/api/settings/routing').then((r: any) => {
      setRouting(r.routing);
      setPrices(JSON.stringify(r.prices, null, 2));
    });
    api('/api/settings/budget').then((b: any) => {
      setBudget(b.budget);
      setStatus(b.status);
    });
  };
  useEffect(load, []);

  async function saveRouting() {
    setMsg(null);
    try {
      await api('/api/settings/routing', { method: 'PUT', json: { routing, prices: JSON.parse(prices) } });
      setMsg('Routing saved.');
      load();
    } catch (e) {
      setMsg(e instanceof ApiError ? `Error: ${JSON.stringify(e.body)}` : `Error: ${(e as Error).message}`);
    }
  }
  async function saveBudget() {
    setMsg(null);
    try {
      await api('/api/settings/budget', { method: 'PUT', json: budget });
      setMsg('Budget saved.');
      load();
    } catch (e) {
      setMsg(e instanceof ApiError ? `Error: ${JSON.stringify(e.body)}` : `Error: ${(e as Error).message}`);
    }
  }

  if (!routing || !budget) return <p>Loading…</p>;
  const tiers = ['fast', 'standard', 'advanced'];
  return (
    <section>
      <DesignPending />
      <h1>Routing &amp; budget</h1>
      {!admin && <p>Only admins can change these settings.</p>}
      {msg && <p role="status">{msg}</p>}

      <h2>Model tiers</h2>
      <table>
        <thead><tr><th>Tier</th><th>Model id</th><th>Enabled</th></tr></thead>
        <tbody>
          {tiers.map((t) => (
            <tr key={t}>
              <td>{t}</td>
              <td>
                <input size={50} disabled={!admin} value={routing.tiers[t].model_id}
                  onChange={(e) => setRouting({ ...routing, tiers: { ...routing.tiers, [t]: { ...routing.tiers[t], model_id: e.target.value } } })} />
              </td>
              <td>
                <input type="checkbox" disabled={!admin} checked={routing.tiers[t].enabled}
                  onChange={(e) => setRouting({ ...routing, tiers: { ...routing.tiers, [t]: { ...routing.tiers[t], enabled: e.target.checked } } })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Tasks</h2>
      <table>
        <thead><tr><th>Task</th><th>Default tier</th><th>Override</th></tr></thead>
        <tbody>
          {Object.keys(routing.tasks).map((task) => (
            <tr key={task}>
              <td>{task}</td>
              <td>{routing.tasks[task]}</td>
              <td>
                <select disabled={!admin} value={routing.overrides?.[task] || ''}
                  onChange={(e) => {
                    const o = { ...(routing.overrides || {}) };
                    if (e.target.value) o[task] = e.target.value;
                    else delete o[task];
                    setRouting({ ...routing, overrides: o });
                  }}>
                  <option value="">(auto)</option>
                  {tiers.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <label>
          <input type="checkbox" disabled={!admin} checked={routing.escalate_when_unsure}
            onChange={(e) => setRouting({ ...routing, escalate_when_unsure: e.target.checked })} /> Escalate to a higher tier when unsure
        </label>
      </p>

      <h2>Prices ($ per 1M tokens)</h2>
      <p><textarea rows={12} cols={80} disabled={!admin} value={prices} onChange={(e) => setPrices(e.target.value)} /></p>
      {admin && <button type="button" onClick={saveRouting}>Save routing &amp; prices</button>}

      <h2>Monthly budget</h2>
      {status && <p>This month: {usd(status.spent_usd)} of {usd(status.amount_usd)} — state {status.state}</p>}
      <p>
        <label>Monthly budget (USD, 0 = no budget) <input type="number" min={0} step="any" disabled={!admin} value={budget.monthly_usd}
          onChange={(e) => setBudget({ ...budget, monthly_usd: Number(e.target.value) })} /></label>
      </p>
      <p>
        <label>Alert at % <input type="number" min={1} max={100} disabled={!admin} value={budget.alert_pct}
          onChange={(e) => setBudget({ ...budget, alert_pct: Number(e.target.value) })} /></label>
      </p>
      <p>
        <label>
          When over budget{' '}
          <select disabled={!admin} value={budget.over_action} onChange={(e) => setBudget({ ...budget, over_action: e.target.value })}>
            <option value="warn">Warn only</option>
            <option value="fast_only">Fast model only</option>
            <option value="pause">Pause chat</option>
          </select>
        </label>
      </p>
      {admin && <button type="button" onClick={saveBudget}>Save budget</button>}
    </section>
  );
}
