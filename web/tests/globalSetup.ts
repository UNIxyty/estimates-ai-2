import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';

/**
 * Creates an isolated database `<name>_web_test` next to the configured one and applies every
 * db/migrations/*.sql in order, so web tests never race other suites (e.g. the worker's) that
 * share the dev database. Set WEB_TEST_USE_BASE_DB=1 to run against the base DB directly.
 */
declare module 'vitest' {
  export interface ProvidedContext {
    dbUrl: string;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = process.env.MIGRATIONS_DIR || path.resolve(here, '../../db/migrations');

export default async function setup(project: TestProject) {
  const base = process.env.TEST_DATABASE_URL || process.env.ESTIMATES_DATABASE_URL || 'postgresql://estimates:dev@127.0.0.1:5433/estimates';
  if (process.env.WEB_TEST_USE_BASE_DB === '1') {
    project.provide('dbUrl', base);
    return;
  }
  const u = new URL(base);
  const baseName = u.pathname.replace(/^\//, '') || 'estimates';
  const testName = `${baseName}_web_test`;
  const admin = postgres(base, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${testName}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${testName}"`);
  } catch (e) {
    console.warn(`[tests] cannot create ${testName} (${(e as Error).message}); using ${baseName} directly`);
    await admin.end();
    project.provide('dbUrl', base);
    return;
  }
  await admin.end();

  u.pathname = `/${testName}`;
  const url = u.toString();
  const db = postgres(url, { max: 1, onnotice: () => {} });
  try {
    if (!existsSync(MIGRATIONS)) throw new Error(`migrations dir not found: ${MIGRATIONS}`);
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
      await db.unsafe(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
  } finally {
    await db.end();
  }
  project.provide('dbUrl', url);
}
