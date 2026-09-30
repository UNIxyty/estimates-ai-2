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
