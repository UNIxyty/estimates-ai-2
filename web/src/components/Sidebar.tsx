'use client';

/** design/Sidebar.dc.html — brand, New estimate, navigation, conversations by date, user + theme toggle. */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { currentTheme, setThemePref } from '@/lib/theme';
import { useUser } from './UserContext';
import { initials, MONO } from './ui';

interface Conv { id: string; title: string; last_activity_at: string; last_run_status: string | null; language: string | null }
const BUSY = new Set(['queued', 'running', 'waiting', 'paused_cost']);
const BUILD = process.env.NEXT_PUBLIC_BUILD_HASH || 'dev';

function groupLabel(v: string): string {
  const d = new Date(v), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  return d.toLocaleDateString('en-GB', { month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export function Sidebar({ mobile, open, onClose, collapsedOverride, reloadKey }: {
  mobile: boolean; open: boolean; onClose: () => void; collapsedOverride: boolean | null; reloadKey: number;
}) {
  const user = useUser();
  const path = usePathname() || '';
  const [pref, setPref] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [convs, setConvs] = useState<Conv[]>([]);
  const [files, setFiles] = useState<number | null>(null);

  useEffect(() => {
    try { setPref(localStorage.getItem('eaa-side') === '1'); } catch {}
    setTheme(currentTheme());
    const t = (e: Event) => setTheme((e as CustomEvent).detail);
    window.addEventListener('eaa:theme', t);
    return () => window.removeEventListener('eaa:theme', t);
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const [c, k] = await Promise.all([api<{ conversations: Conv[] }>('/api/conversations'), api<{ counts: { total: number } }>('/api/knowledge/status')]);
        if (!alive) return;
        setConvs(c.conversations);
        setFiles(k.counts.total);
        if (c.conversations.some((x) => x.last_run_status && BUSY.has(x.last_run_status))) timer = setTimeout(load, 8000);
      } catch {}
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [reloadKey, path]);

  // Close the phone drawer after navigating.
  useEffect(() => { if (mobile && open) onClose(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [path]);

  const collapsed = !mobile && (collapsedOverride ?? pref);
  const visible = !mobile || open;
  const act = path.startsWith('/knowledge') || path.startsWith('/setup') ? 'knowledge'
    : path.startsWith('/history') ? 'history' : path.startsWith('/settings') ? 'settings' : 'chat';
  const cur = path.startsWith('/chat/') ? path.split('/')[2] : '';

  const toggle = () => {
    if (mobile) { onClose(); return; }
    const c = !collapsed;
    setPref(c);
    try { localStorage.setItem('eaa-side', c ? '1' : '0'); } catch {}
  };
  const toggleTheme = () => setTheme(setThemePref(theme === 'dark' ? 'light' : 'dark'));

  const nav: [string, string, string, string, string][] = [
    ['knowledge', 'Knowledge base', '/knowledge', '▤', files == null ? '' : `${files} file${files === 1 ? '' : 's'}`],
    ['history', 'History', '/history', '◷', ''],
    ['settings', 'Settings', '/settings/usage', '◎', ''],
  ];

  let lastGroup = '';
  const rows = convs.map((c) => {
    const g = groupLabel(c.last_activity_at);
    const group = g !== lastGroup ? g : null;
    lastGroup = g;
    return { ...c, group };
  });

  if (!visible) return null;
  return (
    <>
      {mobile && open && <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(10,12,16,0.4)' }} />}
      <aside aria-label="Sidebar" style={{ width: collapsed ? 60 : mobile ? 290 : 264, height: '100%', flex: 'none', display: 'flex', flexDirection: 'column', background: 'var(--side)', borderRight: '1px solid var(--line)', fontSize: 13.5, color: 'var(--ink)', position: mobile ? 'fixed' : 'relative', left: 0, top: 0, bottom: 0, zIndex: 41, boxShadow: mobile ? '0 10px 40px rgba(0,0,0,0.25)' : 'none', transition: 'width .15s ease' }}>
        <div style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px 0 14px' }}>
          {!collapsed && (
            <Link href="/chat" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'var(--ink)', flex: 1, minWidth: 0 }}>
              <span style={{ width: 24, height: 24, flex: 'none', borderRadius: 6, background: 'var(--acc)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 12, fontWeight: 600 }}>E</span>
              <span style={{ fontWeight: 600, fontSize: 14.5, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>Estimates AI Agent</span>
            </Link>
          )}
          <button type="button" onClick={toggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="hv-sunk"
            style={{ width: 32, height: 32, flex: 'none', border: 0, borderRadius: 8, background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ width: 16, height: 13, border: '1.5px solid var(--ink2)', borderRadius: 3, display: 'flex' }}><span style={{ width: 5, borderRight: '1.5px solid var(--ink2)' }} /></span>
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 8px 10px' }}>
          <Link href="/chat" title="New estimate" className="hv-accSoft" style={{ display: 'flex', alignItems: 'center', gap: 10, height: 38, padding: '0 10px', borderRadius: 9, textDecoration: 'none', color: 'var(--accInk)', fontWeight: 600 }}>
            <span style={{ width: 22, height: 22, flex: 'none', borderRadius: '50%', background: 'var(--acc)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, lineHeight: 1 }}>+</span>
            {!collapsed && <span>New estimate</span>}
          </Link>
          {nav.map(([k, label, href, icon, meta]) => (
            <Link key={k} href={href} title={label} className="hv-sunk" aria-current={act === k ? 'page' : undefined}
              style={{ display: 'flex', alignItems: 'center', gap: 10, height: 36, padding: '0 10px', borderRadius: 9, textDecoration: 'none', color: act === k ? 'var(--ink)' : 'var(--ink2)', background: act === k ? 'var(--sunk)' : 'transparent', fontWeight: act === k ? 500 : 400 }}>
              <span style={{ width: 22, flex: 'none', textAlign: 'center', color: 'var(--ink3)', fontSize: 14 }}>{icon}</span>
              {!collapsed && <><span style={{ flex: 1 }}>{label}</span><span style={{ fontSize: 11.5, color: 'var(--ink3)' }}>{meta}</span></>}
            </Link>
          ))}
        </div>
        <div className="scroll-thin" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 8px 8px' }}>
          {!collapsed && rows.map((c) => (
            <div key={c.id}>
              {c.group && <div style={{ padding: '14px 10px 6px', fontSize: 11.5, fontWeight: 500, color: 'var(--ink3)' }}>{c.group}</div>}
              <Link href={`/chat/${c.id}`} className="hv-sunk" aria-current={cur === c.id ? 'page' : undefined}
                style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px', borderRadius: 8, textDecoration: 'none', color: 'var(--ink)', background: cur === c.id ? 'var(--sunk)' : 'transparent' }}>
                <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
                {c.last_run_status && BUSY.has(c.last_run_status) && <span title="Agent is working" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--acc)', flex: 'none' }} />}
                {c.language && <span style={{ flex: 'none', fontFamily: MONO, fontSize: 9.5, fontWeight: 600, color: 'var(--ink3)' }}>{c.language.toUpperCase().slice(0, 2)}</span>}
              </Link>
            </div>
          ))}
        </div>
        <div style={{ flex: 'none', borderTop: '1px solid var(--line)', padding: '10px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Link href="/settings/profile" className="hv-sunk" title={`${user.name || user.email} · build ${BUILD}`}
            style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px', borderRadius: 8, textDecoration: 'none', color: 'var(--ink)' }}>
            <span style={{ width: 30, height: 30, flex: 'none', borderRadius: '50%', background: 'var(--accSoft)', color: 'var(--accInk)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 600 }}>{initials(user.name, user.email)}</span>
            {!collapsed && (
              <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0 }}>
                <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.name || user.email}</span>
                <span style={{ fontSize: 11.5, color: 'var(--ink3)' }}>{user.role === 'admin' ? 'Admin' : 'Estimator'}<span data-build={BUILD} style={{ fontFamily: MONO, fontSize: 10, marginLeft: 6, opacity: 0.7 }}>{BUILD}</span></span>
              </span>
            )}
          </Link>
          {!collapsed && (
            <button type="button" onClick={toggleTheme} title="Switch theme" className="hv-ink"
              style={{ height: 30, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--ink2)', fontSize: 12, cursor: 'pointer' }}>
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
