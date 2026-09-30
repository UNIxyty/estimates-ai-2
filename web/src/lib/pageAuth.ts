import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, validateSessionToken } from './auth/session';

/** Server components: the signed-in active user, or redirect to /login. */
export async function pageUser() {
  const jar = await cookies();
  const res = await validateSessionToken(jar.get(SESSION_COOKIE)?.value ?? null);
  if (!res) redirect('/login');
  return res.user;
}
