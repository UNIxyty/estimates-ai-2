'use client';

/**
 * App frame: Sidebar | page. Pages render their own header (as in the design). The shell context lets a page
 * open the phone drawer, collapse the sidebar while a document is open in split view, and ask the sidebar to
 * reload its conversation list after creating or renaming a conversation.
 */
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Sidebar } from './Sidebar';
import { useIsMobile } from './ui';

interface ShellCtx {
  mobile: boolean;
  openDrawer: () => void;
  /** true/false forces the sidebar state (e.g. split view); null restores the user's choice. */
  setCollapsedOverride: (v: boolean | null) => void;
  refreshConversations: () => void;
}

const Ctx = createContext<ShellCtx>({ mobile: false, openDrawer: () => {}, setCollapsedOverride: () => {}, refreshConversations: () => {} });
export const useShell = () => useContext(Ctx);

export function Shell({ children }: { children: React.ReactNode }) {
  const mobile = useIsMobile();
  const [drawer, setDrawer] = useState(false);
  const [override, setOverride] = useState<boolean | null>(null);
  const [tick, setTick] = useState(0);
  // First-run setup is a standalone page with its own top bar (design/setup.dc.html), no sidebar.
  const standalone = (usePathname() || '').startsWith('/setup');
  const refreshConversations = useCallback(() => setTick((t) => t + 1), []);
  const value = useMemo<ShellCtx>(() => ({
    mobile,
    openDrawer: () => setDrawer(true),
    setCollapsedOverride: setOverride,
    refreshConversations,
  }), [mobile, refreshConversations]);
  return (
    <Ctx.Provider value={value}>
      <div style={{ height: '100dvh', display: 'flex', background: 'var(--bg)', color: 'var(--ink)', overflow: 'hidden' }}>
        {!standalone && <Sidebar mobile={mobile} open={drawer} onClose={() => setDrawer(false)} collapsedOverride={override} reloadKey={tick} />}
        <div style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{children}</div>
      </div>
    </Ctx.Provider>
  );
}

/** The ☰ button pages show in their header on phone widths. */
export function MenuButton() {
  const { mobile, openDrawer } = useShell();
  if (!mobile) return null;
  return (
    <button type="button" onClick={openDrawer} aria-label="Open menu"
      style={{ width: 40, height: 40, flex: 'none', border: 0, borderRadius: 10, background: 'transparent', color: 'var(--ink)', fontSize: 18, cursor: 'pointer' }}>☰</button>
  );
}
