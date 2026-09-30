import type { NextRequest } from 'next/server';
import { route, uuidParam } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { ownedRun } from '@/lib/access';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SSE proxy. Ownership is checked here; the worker replays run_events with seq > after, then tails.
 * Resume point: Last-Event-ID header (EventSource auto-reconnect) or ?after=.
 */
export const GET = route<{ id: string }>(async (req: NextRequest, p) => {
  const { user } = await requireUser(req);
  const run = await ownedRun(user.id, uuidParam(p.id));
  const sp = new URL(req.url).searchParams;
  const raw = req.headers.get('last-event-id') ?? sp.get('after') ?? '0';
  const after = Math.max(0, Math.trunc(Number(raw)) || 0);

  const upstreamAbort = new AbortController();
  req.signal.addEventListener('abort', () => upstreamAbort.abort(), { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(`${env.workerUrl()}/internal/runs/${run.id}/events?after=${after}`, {
      headers: { 'X-Internal-Token': env.internalToken(), Accept: 'text/event-stream' },
      signal: upstreamAbort.signal,
      cache: 'no-store',
    });
  } catch {
    return sseError('worker_unreachable');
  }
  if (!upstream.ok || !upstream.body) {
    upstreamAbort.abort();
    return sseError(`worker_status_${upstream.status}`);
  }

  const reader = upstream.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      upstreamAbort.abort();
      reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, { headers: sseHeaders() });
});

function sseHeaders(): HeadersInit {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

/** A proxy failure is reported as a stream event so EventSource retries (with its own backoff). */
function sseError(reason: string): Response {
  const body = `retry: 3000\nevent: proxy.error\ndata: ${JSON.stringify({ error: reason })}\n\n`;
  return new Response(body, { headers: sseHeaders() });
}
