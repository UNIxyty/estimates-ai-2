import type { CSSProperties, ReactNode } from 'react';
import { BuildFooter } from '@/components/BuildFooter';

/** Signed-out page chrome shared by /login and /set-password (design/login.dc.html, set-password.dc.html). */
export function AuthFrame({ children, cardMaxWidth = 400, note }: { children: ReactNode; cardMaxWidth?: number; note?: ReactNode }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 28, padding: '32px 20px 44px', background: 'var(--bg)', color: 'var(--ink)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--acc)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600 }}>E</span>
        <span style={{ fontWeight: 600, fontSize: 17, letterSpacing: '-0.01em' }}>Estimates AI Agent</span>
      </div>
      <main style={{ width: '100%', maxWidth: cardMaxWidth, display: 'flex', flexDirection: 'column', gap: 18, padding: 28, border: '1px solid var(--line)', borderRadius: 16, background: 'var(--panel)', boxShadow: '0 1px 2px rgba(16,24,40,0.04),0 12px 32px rgba(16,24,40,0.06)' }}>
        {children}
      </main>
      {note && <div style={{ maxWidth: cardMaxWidth, textAlign: 'center', fontSize: 13, color: 'var(--ink3)', lineHeight: 1.5 }}>{note}</div>}
      <BuildFooter />
    </div>
  );
}

export function AuthHeading({ title, sub, gap = 4 }: { title: ReactNode; sub?: ReactNode; gap?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</h1>
      {sub && <div style={{ fontSize: 14, color: 'var(--ink2)', lineHeight: 1.5 }}>{sub}</div>}
    </div>
  );
}

/** Round status mark used by the "Check your email" / "This link has expired" states. */
export function AuthMark({ tone, children }: { tone: 'ok' | 'warn' | 'err'; children: ReactNode }) {
  const bg = { ok: 'var(--okSoft)', warn: 'var(--warnSoft)', err: 'var(--errSoft)' }[tone];
  const fg = { ok: 'var(--ok)', warn: 'var(--warn)', err: 'var(--err)' }[tone];
  return (
    <span aria-hidden style={{ width: 36, height: 36, borderRadius: '50%', background: bg, color: fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: tone === 'ok' ? 400 : 700 }}>
      {children}
    </span>
  );
}

export function AuthError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--errSoft)', color: 'var(--err)', fontSize: 13.5, lineHeight: 1.45 }}>
      {children}
    </div>
  );
}

export const authLabel: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13.5, fontWeight: 500 };
export const authInput: CSSProperties = { height: 44, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontWeight: 400, fontSize: 15, outlineColor: 'var(--acc)', width: '100%', minWidth: 0 };
export const authPrimary = (enabled = true): CSSProperties => ({
  height: 44, border: 0, borderRadius: 10, background: enabled ? 'var(--acc)' : 'var(--ink3)', color: '#fff', font: 'inherit', fontSize: 15, fontWeight: 600,
  cursor: enabled ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%',
});
export const authBack: CSSProperties = { height: 36, border: 0, background: 'transparent', color: 'var(--ink2)', font: 'inherit', fontSize: 14, cursor: 'pointer' };
