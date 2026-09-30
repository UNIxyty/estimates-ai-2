'use client';

import Link from 'next/link';
import { api } from '@/lib/client';

export function Nav({ user }: { user: { name: string; email: string; role: string } }) {
  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  }
  return (
    <nav aria-label="Main">
      <ul>
        <li><Link href="/chat">New chat</Link></li>
        <li><Link href="/history">History</Link></li>
        <li><Link href="/knowledge">Knowledge</Link></li>
        <li><Link href="/setup">Setup</Link></li>
        <li><Link href="/settings/usage">Usage</Link></li>
        <li><Link href="/settings/routing">Routing &amp; budget</Link></li>
        <li><Link href="/settings/profile">Profile</Link></li>
        {user.role === 'admin' && <li><Link href="/settings/users">Users</Link></li>}
      </ul>
      <p>
        Signed in as {user.name || user.email} ({user.role}) <button type="button" onClick={logout}>Sign out</button>
      </p>
    </nav>
  );
}
