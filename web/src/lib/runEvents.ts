import { json, type Tx } from './db';

/**
 * Append a run event with seq = max+1. The caller must hold `SELECT … FROM runs WHERE id=$1 FOR UPDATE`
 * in the same transaction (serialises seq allocation between web requests). The worker may append
 * concurrently without that lock, so a unique violation on (run_id, seq) is retried inside a savepoint.
 */
export async function appendRunEvent(tx: Tx, runId: string, type: string, payload: unknown): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      const rows = await tx.savepoint(async (sp) =>
        sp<{ seq: number }[]>`
          INSERT INTO run_events (run_id, seq, type, payload)
          SELECT ${runId}, COALESCE(MAX(seq), 0) + 1, ${type}, ${json(payload)}
            FROM run_events WHERE run_id = ${runId}
          RETURNING seq`,
      );
      await tx`SELECT pg_notify('run_events', ${runId})`;
      return rows[0].seq;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505' && attempt < 5) continue;
      throw e;
    }
  }
}
