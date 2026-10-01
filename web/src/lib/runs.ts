import { sql } from './db';
import { appendRunEvent } from './runEvents';

/**
 * Stop: flag + NOTIFY run_cancel. A run with no live worker loop (queued / waiting / paused_cost) is
 * cancelled right here, with a terminal run.status event so open streams close.
 */
export async function stopRun(runId: string) {
  return sql.begin(async (tx) => {
    const before = (await tx<{ status: string }[]>`SELECT status FROM runs WHERE id = ${runId} FOR UPDATE`)[0];
    const flagged = await tx<{ id: string }[]>`
      UPDATE runs SET cancel_requested = true
       WHERE id = ${runId} AND status IN ('queued','running','waiting','paused_cost') RETURNING id`;
    if (!flagged[0]) return { run: (await tx`SELECT * FROM runs WHERE id = ${runId}`)[0], stopped: false };
    await tx`SELECT pg_notify('run_cancel', ${runId})`;
    if (before && ['queued', 'waiting', 'paused_cost'].includes(before.status)) {
      await tx`UPDATE runs SET status = 'cancelled', finished_at = now() WHERE id = ${runId}`;
      await tx`UPDATE jobs SET status = 'cancelled', finished_at = now()
                WHERE status = 'queued' AND (dedupe_key = ${`run:${runId}`} OR (kind = 'resume_run' AND payload->>'run_id' = ${runId}))`;
      await appendRunEvent(tx, runId, 'run.status', { status: 'cancelled' });
    }
    return { run: (await tx`SELECT * FROM runs WHERE id = ${runId}`)[0], stopped: true };
  });
}

/** Where a queued run stands: how many agent jobs will start before it (0 = next), and how many are running. */
export async function queuePosition(runId: string): Promise<{ status: string; ahead: number; running: number }> {
  const [row] = await sql<{ status: string; ahead: number; running: number }[]>`
    WITH me AS (
      SELECT j.id, j.run_after FROM jobs j
       WHERE j.kind IN ('run_agent', 'resume_run') AND j.payload->>'run_id' = ${runId} AND j.status = 'queued'
       ORDER BY j.run_after, j.id LIMIT 1)
    SELECT (SELECT status FROM runs WHERE id = ${runId}) AS status,
           COALESCE((SELECT count(*)::int FROM jobs j, me
                      WHERE j.status = 'queued' AND j.run_after <= now()
                        AND (j.run_after, j.id) < (me.run_after, me.id)), 0) AS ahead,
           (SELECT count(*)::int FROM jobs WHERE status = 'running') AS running`;
  return row;
}
