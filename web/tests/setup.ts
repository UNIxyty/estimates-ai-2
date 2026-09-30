import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

process.env.ESTIMATES_DATABASE_URL ||= 'postgresql://estimates:dev@127.0.0.1:5433/estimates';
process.env.SESSION_SECRET ||= 'test-session-secret-0123456789abcdef';
process.env.APP_URL ||= 'http://localhost:3000';
process.env.WORKER_URL ||= 'http://127.0.0.1:9'; // nothing listens: worker calls fail fast
process.env.INTERNAL_TOKEN ||= 'test-internal-token';
process.env.UNDO_SECONDS ||= '10';
process.env.RUN_COST_CAP_USD ||= '2';
process.env.DATA_DIR ||= mkdtempSync(path.join(tmpdir(), 'estimates-web-test-'));
process.env.DB_POOL_MAX ||= '10';

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  await closeDb();
});
