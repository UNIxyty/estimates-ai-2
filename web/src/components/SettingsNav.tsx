'use client';

/** design/SettingsNav.dc.html plus the settings page frame (nav column + content) shared by the settings pages. */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MenuButton } from './Shell';
import { useUser } from './UserContext';

const ITEMS: [string, string, boolean][] = [['usage', 'Usage & costs', false], ['routing', 'Model routing', false], ['profile', 'Profile', false], ['users', 'Users', true]];

export function SettingsNav() {
  const path = usePathname() || '';
  const user = useUser();
  return (
    <nav aria-label="Settings" style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 13.5 }}>
      <div style={{ padding: '0 10px 10px', fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ink)' }}>Settings</div>
      {ITEMS.filter(([, , admin]) => !admin || user.role === 'admin').map(([k, label, admin]) => {
        const on = path.startsWith(`/settings/${k}`);
        return (
          <Link key={k} href={`/settings/${k}`} className="hv-sunk" aria-current={on ? 'page' : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 10px', borderRadius: 8, textDecoration: 'none', color: on ? 'var(--ink)' : 'var(--ink2)', background: on ? 'var(--sunk)' : 'transparent', fontWeight: on ? 500 : 400 }}>
            {label}
            {admin && <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 500, color: 'var(--ink3)', border: '1px solid var(--line)', borderRadius: 4, padding: '0 5px' }}>Admin</span>}
          </Link>
        );
      })}
    </nav>
  );
}

/** <main> with the 200px settings nav on the left; `maxWidth` matches each page's design width. */
export function SettingsFrame({ maxWidth, contentMaxWidth, children }: { maxWidth: number; contentMaxWidth?: number; children: React.ReactNode }) {
  return (
    <main style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
      <div style={{ maxWidth, margin: '0 auto', padding: '24px 20px 48px', display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ width: 200, flex: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <MenuButton />
          <SettingsNav />
        </div>
        <div style={{ flex: 1, minWidth: 300, maxWidth: contentMaxWidth, display: 'flex', flexDirection: 'column', gap: 20 }}>{children}</div>
      </div>
    </main>
  );
}
