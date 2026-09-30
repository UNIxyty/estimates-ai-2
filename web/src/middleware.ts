import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge gate for pages only: no session cookie → /login. This is a convenience redirect; the real
 * checks are server-side (the (app) layout validates the session against the DB, and every /api
 * handler calls requireUser/requireAdmin itself).
 */
const PUBLIC = ['/login', '/set-password'];

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + '/'))) return NextResponse.next();
  if (req.cookies.get('est_session')?.value) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname && pathname !== '/' ? `?next=${encodeURIComponent(pathname + search)}` : '';
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except API routes, Next internals and static files.
  matcher: ['/((?!api/|_next/|favicon\\.ico|robots\\.txt).*)'],
};
