import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { takeSessionRenewal } from './auth/session';

export class HttpError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) {
    super(code);
  }
}

export const notFound = () => new HttpError(404, 'not_found');
export const forbidden = () => new HttpError(403, 'forbidden');
export const badRequest = (code = 'bad_request', extra: Record<string, unknown> = {}) =>
  new HttpError(400, code, extra);

export function json(data: unknown, init?: number | ResponseInit): NextResponse {
  const i = typeof init === 'number' ? { status: init } : init;
  return NextResponse.json(data, { ...i, headers: { 'Cache-Control': 'no-store', ...(i?.headers || {}) } });
}

export type RouteCtx<P> = { params: Promise<P> };

/**
 * Wraps a route handler: resolves params, maps HttpError/ZodError to JSON errors, and attaches a
 * renewed session cookie if requireUser() extended the session during this request.
 */
export function route<P = Record<string, never>>(
  fn: (req: NextRequest, params: P) => Promise<Response>,
) {
  return async (req: NextRequest, ctx: RouteCtx<P>): Promise<Response> => {
    let res: Response;
    try {
      const params = (ctx && ctx.params ? await ctx.params : {}) as P;
      res = await fn(req, params);
    } catch (e) {
      res = errorResponse(e);
    }
    const renewal = takeSessionRenewal(req);
    if (renewal) res.headers.append('Set-Cookie', renewal);
    return res;
  };
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.code, ...e.extra }, e.status);
  if (e instanceof ZodError) {
    return json({ error: 'invalid_input', issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 400);
  }
  console.error('[api] unhandled error', e);
  return json({ error: 'internal_error' }, 500);
}

export async function readJson<T extends ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest('invalid_json');
  }
  return schema.parse(body);
}

export function clientIp(req: Request): string {
  const h = req.headers;
  return (
    h.get('cf-connecting-ip') ||
    (h.get('x-forwarded-for') || '').split(',')[0].trim() ||
    h.get('x-real-ip') ||
    'unknown'
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
/** Path ids that are not uuids can never match a row: answer 404 without hitting the DB. */
export function uuidParam(v: unknown): string {
  if (!isUuid(v)) throw notFound();
  return v;
}

export function intParam(v: string | null, def: number, min: number, max: number): number {
  const n = v === null || v === '' ? def : Math.trunc(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** RFC 6266 / 5987 Content-Disposition with a UTF-8 filename. */
export function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
