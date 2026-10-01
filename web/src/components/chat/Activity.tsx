'use client';

/**
 * What the agent is doing right now, as a live element (not just "working"): in queue (with position), starting,
 * thinking (a model call in flight, with its tier), searching supplier sites (with the query). Driven by the
 * run status, GET /api/runs/{id}/queue and `agent.state` run events. Steps and streaming text show themselves.
 */
import { useEffect, useState } from 'react';
import { fmtElapsed } from './Blocks';
import type { LiveRun } from './types';
import s from './Chat.module.css';

function Dots() {
  return <span className={s.dots} aria-hidden><i /><i /><i /></span>;
}

export function AgentActivity({ run, onStop, showStarting = true }: { run: LiveRun; onStop?: () => void; showStarting?: boolean }) {
  const a = run.activity;
  const since = a?.since ?? (Date.parse(run.created_at || '') || Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = fmtElapsed(Math.max(0, now - since));

  let icon: React.ReactNode, label: string, detail: string | null = null, bar = false;
  if (run.status === 'queued') {
    icon = <span className={s.pulse} aria-hidden />;
    label = 'In queue';
    const ahead = run.queue?.ahead;
    detail = ahead == null ? 'waiting for the agent to start' : ahead === 0 ? 'starting next' : `${ahead} request${ahead === 1 ? '' : 's'} ahead`;
  } else if (a?.state === 'thinking') {
    icon = <Dots />;
    label = 'Thinking';
    detail = a.tier ? `${a.tier} model` : null;
  } else if (a?.state === 'searching') {
    icon = <span className={s.glass} aria-hidden>⌕</span>;
    label = 'Searching supplier sites';
    detail = a.query ? `“${a.query.length > 60 ? `${a.query.slice(0, 60)}…` : a.query}”` : null;
    bar = true;
  } else if (showStarting) {
    icon = <Dots />;
    label = 'Starting';
    bar = true;
  } else return null;

  return (
    <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minHeight: 30, padding: '4px 2px', fontSize: 13.5, color: 'var(--ink2)' }}>
      <span style={{ width: 22, display: 'inline-flex', justifyContent: 'center', flex: 'none' }}>{icon}</span>
      <span className={s.shimmer} style={{ fontWeight: 500 }}>{label}…</span>
      {detail && <span style={{ color: 'var(--ink3)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>{detail}</span>}
      {bar && <span className={s.indeterminate} aria-hidden />}
      <span style={{ color: 'var(--ink3)', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{elapsed}</span>
      {onStop && (
        <button type="button" onClick={onStop} className="hv-sunk"
          style={{ marginLeft: 'auto', height: 26, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel)', color: 'var(--ink2)', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}>Stop</button>
      )}
    </div>
  );
}
