import { sql } from '@/lib/db';
import { env } from '@/lib/env';
import { json, route } from '@/lib/http';
import { workerHealth } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public liveness: {ok, build, db, worker}. No secrets, no user data. */
export const GET = route(async () => {
  let db: 'ok' | 'error' = 'ok';
  try {
    await sql`SELECT 1`;
  } catch {
    db = 'error';
  }
  const worker = await workerHealth();
  return json({ ok: db === 'ok', build: env.buildHash(), db, worker }, db === 'ok' ? 200 : 503);
});
