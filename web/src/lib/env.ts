/** Environment accessors. Read lazily (never at import time) so `next build` works without env. */

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function num(name: string, fallback: number): number {
  const n = Number(str(name));
  return str(name) === '' || !Number.isFinite(n) ? fallback : n;
}

export const env = {
  databaseUrl: () => str('ESTIMATES_DATABASE_URL', 'postgresql://estimates:estimates@db:5432/estimates'),
  sessionSecret: () => {
    const s = str('SESSION_SECRET');
    if (!s) {
      if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is not set');
      return 'dev-only-session-secret-change-me';
    }
    return s;
  },
  appUrl: () => str('APP_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  workerUrl: () => str('WORKER_URL', 'http://worker:8000').replace(/\/+$/, ''),
  internalToken: () => str('INTERNAL_TOKEN'),
  dataDir: () => str('DATA_DIR', '/data/files').replace(/\/+$/, ''),
  runCostCapUsd: () => num('RUN_COST_CAP_USD', 2),
  undoSeconds: () => num('UNDO_SECONDS', 10),
  buildHash: () => str('BUILD_HASH', 'dev'),
  modelFast: () => str('BEDROCK_MODEL_FAST', 'eu.anthropic.claude-haiku-4-5-20251001-v1:0'),
  modelStandard: () => str('BEDROCK_MODEL_STANDARD', 'eu.anthropic.claude-sonnet-4-6'),
  modelAdvanced: () => str('BEDROCK_MODEL_ADVANCED', 'eu.anthropic.claude-opus-4-6-v1'),
  secureCookies: () => str('APP_URL', 'http://localhost:3000').startsWith('https://'),
};

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const PERMISSION_CARD_MINUTES = 30;
