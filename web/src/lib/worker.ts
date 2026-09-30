import { env } from './env';
import { HttpError, json } from './http';

/** Calls to the internal worker API. The browser never talks to the worker directly. */
export async function workerFetch(pathAndQuery: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('X-Internal-Token', env.internalToken());
  const signal = rest.signal ?? AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(`${env.workerUrl()}${pathAndQuery}`, { ...rest, headers, signal, cache: 'no-store' });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError' && rest.signal?.aborted) throw e;
    throw new HttpError(502, 'worker_unreachable');
  }
}

/** Proxy a worker JSON (or HTML) response through unchanged (status + body). */
export async function proxyWorker(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  const res = await workerFetch(pathAndQuery, init);
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

/** Fire-and-forget worker notification (e.g. recompute after an override). Never fails the request. */
export function workerPoke(pathAndQuery: string, body: unknown = {}): void {
  workerFetch(pathAndQuery, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    timeoutMs: 5000,
  }).catch(() => {});
}

export async function workerHealth(): Promise<unknown> {
  try {
    const res = await fetch(`${env.workerUrl()}/health`, { signal: AbortSignal.timeout(2000), cache: 'no-store' });
    if (!res.ok) return 'unreachable';
    return await res.json();
  } catch {
    return 'unreachable';
  }
}

export { json };
