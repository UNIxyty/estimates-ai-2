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
  // Next's middleware needs an absolute Location. Build it from the forwarded host/proto (cloudflared passes the
  // public hostname), not nextUrl, whose host is the bind address (0.0.0.0 / localhost) in standalone Docker.
  const next = pathname && pathname !== '/' ? `?next=${encodeURIComponent(pathname + search)}` : '';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || req.nextUrl.host;
  const proto = (req.headers.get('x-forwarded-proto') || req.nextUrl.protocol.replace(':', '')).split(',')[0].trim();
  return NextResponse.redirect(new URL(`/login${next}`, `${proto}://${host}`), 307);
}

export const config = {
  // Everything except API routes, Next internals and static files.
  matcher: ['/((?!api/|_next/|favicon\\.ico|icon\\.svg|robots\\.txt).*)'],
};
