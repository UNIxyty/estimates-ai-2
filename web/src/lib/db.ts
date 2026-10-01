import postgres from 'postgres';
import { env } from './env';

/**
 * One shared postgres.js client per process. Kept on globalThis so Next dev hot-reload does not
 * open a new pool on every edit. Created lazily so importing this module never needs env/DB.
 */
type Sql = postgres.Sql<Record<string, unknown>>;
export type Tx = postgres.TransactionSql<Record<string, unknown>>;
export type Q = Sql | Tx;

const g = globalThis as unknown as { __estimatesSql?: Sql };

function create(): Sql {
  return postgres(env.databaseUrl(), {
    max: Number(process.env.DB_POOL_MAX || 10),
    idle_timeout: 30,
    connect_timeout: 10,
    connection: { TimeZone: env.appTimezone() },
    onnotice: () => {},
    // numeric -> JS number for API payloads (costs, quantities). Precision of numeric(18,6) is fine as float.
    types: {
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x: unknown) => String(x),
        parse: (x: string) => Number(x),
      },
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: unknown) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  }) as unknown as Sql;
}

export function getSql(): Sql {
  if (!g.__estimatesSql) g.__estimatesSql = create();
  return g.__estimatesSql;
}

/** Tagged-template proxy: `sql\`SELECT 1\`` and `sql.begin(...)` both work and lazily connect. */
export const sql: Sql = new Proxy(function () {} as unknown as Sql, {
  apply(_t, _this, args) {
    return (getSql() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_t, prop) {
    const real = getSql() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
}) as Sql;

export async function closeDb(): Promise<void> {
  if (g.__estimatesSql) {
    const s = g.__estimatesSql;
    g.__estimatesSql = undefined;
    await s.end({ timeout: 5 });
  }
}

/** Convert a JS value into a jsonb parameter. */
export function json(v: unknown) {
  return getSql().json(v as postgres.JSONValue);
}
