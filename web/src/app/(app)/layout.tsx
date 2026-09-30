import { pageUser } from '@/lib/pageAuth';
import { Nav } from '@/components/Nav';
import { UserProvider } from '@/components/UserContext';

export const dynamic = 'force-dynamic';

/** Authenticated area: validates the session against the DB (middleware only checks the cookie exists). */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await pageUser();
  const u = { id: user.id, email: user.email, name: user.name, role: user.role };
  return (
    <UserProvider user={u}>
      <header>
        <strong>Estimates AI Agent</strong>
        <Nav user={u} />
      </header>
      <main>{children}</main>
    </UserProvider>
  );
}
