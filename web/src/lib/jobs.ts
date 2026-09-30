import { json, sql, type Q } from './db';

export type JobKind = 'ingest_file' | 'run_agent' | 'resume_run' | 'send_email' | 'send_auth_email';

/**
 * Enqueue a job. With a dedupe key, a second enqueue while one with that key is queued/running is a
 * no-op (partial unique index jobs_dedupe_idx) and returns null. `pg_notify('jobs')` inside a
 * transaction is delivered on commit, so the worker never wakes before the row is visible.
 */
export async function enqueueJob(
  q: Q,
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: { dedupeKey?: string; delaySeconds?: number } = {},
): Promise<number | null> {
  const rows = await q<{ id: number }[]>`
    INSERT INTO jobs (kind, payload, dedupe_key, run_after)
    VALUES (${kind}, ${json(payload)}, ${opts.dedupeKey ?? null},
            now() + make_interval(secs => ${opts.delaySeconds ?? 0}::float8))
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running')
    DO NOTHING
    RETURNING id`;
  await q`SELECT pg_notify('jobs', ${kind})`;
  return rows[0]?.id ?? null;
}

export async function notifyJobs(q: Q = sql): Promise<void> {
  await q`SELECT pg_notify('jobs', '')`;
}
