import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';

export const PASSWORD = 'correct horse 42';
let cachedHash: string | null = null;

/** Tracks everything a test file creates so afterAll can remove it. */
export class Fixtures {
  users: string[] = [];
  files: string[] = [];
  usage: number[] = [];

  async user(opts: { role?: 'estimator' | 'admin'; status?: 'active' | 'invited' | 'disabled'; email?: string; password?: string | null } = {}) {
    cachedHash ||= await hashPassword(PASSWORD);
    const email = opts.email ?? `t-${crypto.randomUUID()}@test.local`;
    const hash = opts.password === null ? null : opts.password ? await hashPassword(opts.password) : cachedHash;
    const [u] = await sql<{ id: string; email: string; role: string }[]>`
      INSERT INTO users (email, name, role, status, password_hash)
      VALUES (${email}, 'Test User', ${opts.role ?? 'estimator'}, ${opts.status ?? 'active'}, ${hash})
      RETURNING id, email::text AS email, role`;
    this.users.push(u.id);
    const s = await createSession(u.id);
    return { ...u, token: s.token, cookie: `est_session=${s.token}` };
  }

  async file(opts: { tag?: string; status?: string; uploadedBy?: string | null } = {}) {
    const [f] = await sql<{ id: string }[]>`
      INSERT INTO files (uploaded_by, original_name, ext, stored_path, tag, status, progress)
      VALUES (${opts.uploadedBy ?? null}, 'ref.xlsx', 'xlsx', '/nonexistent/ref.xlsx', ${opts.tag ?? 'reference_estimate'},
              ${opts.status ?? 'analysed'}, 100)
      RETURNING id`;
    this.files.push(f.id);
    return f.id;
  }

  async conversation(userId: string) {
    const [c] = await sql<{ id: string }[]>`INSERT INTO conversations (user_id) VALUES (${userId}) RETURNING id`;
    return c.id;
  }

  async run(conversationId: string, userId: string, status = 'waiting') {
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO runs (conversation_id, user_id, status, cost_cap_usd) VALUES (${conversationId}, ${userId}, ${status}, 2)
      RETURNING id`;
    return r.id;
  }

  async card(runId: string, conversationId: string, kind: string, status: string, payload: Record<string, unknown>, expiresSql: 'future' | 'past' | 'none' = 'future') {
    const exp = expiresSql === 'future' ? sql`now() + interval '30 minutes'` : expiresSql === 'past' ? sql`now() - interval '1 minute'` : sql`NULL`;
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO cards (run_id, conversation_id, kind, status, payload, expires_at)
      VALUES (${runId}, ${conversationId}, ${kind}, ${status}, ${sql.json(payload as never)}, ${exp})
      RETURNING id`;
    return c.id;
  }

  async document(conversationId: string, userId: string, runId: string | null = null) {
    const [d] = await sql<{ id: string }[]>`
      INSERT INTO documents (run_id, conversation_id, user_id, name, stored_path, mode)
      VALUES (${runId}, ${conversationId}, ${userId}, 'Estimate', '/nonexistent/v1.xlsx', 'fill') RETURNING id`;
    return d.id;
  }

  async usageRow(costUsd: number, userId: string | null = null) {
    const [u] = await sql<{ id: number }[]>`
      INSERT INTO usage (user_id, kind, task, tier, cost_usd) VALUES (${userId}, 'llm', 'simple_question', 'fast', ${costUsd})
      RETURNING id`;
    this.usage.push(u.id);
    return u.id;
  }

  async cleanup() {
    const users = this.users;
    const files = this.files;
    if (this.usage.length) await sql`DELETE FROM usage WHERE id = ANY(${this.usage}::bigint[])`;
    // Jobs reference entities only through payload json.
    const runIds = users.length
      ? (await sql<{ id: string }[]>`SELECT id FROM runs WHERE user_id = ANY(${users}::uuid[])`).map((r) => r.id)
      : [];
    const cardIds = runIds.length
      ? (await sql<{ id: string }[]>`SELECT id FROM cards WHERE run_id = ANY(${runIds}::uuid[])`).map((r) => r.id)
      : [];
    const sends = users.length
      ? (await sql<{ id: string }[]>`SELECT id FROM email_sends WHERE user_id = ANY(${users}::uuid[])`).map((r) => r.id)
      : [];
    await sql`DELETE FROM jobs WHERE payload->>'run_id' = ANY(${runIds}::text[])
                                OR payload->>'card_id' = ANY(${cardIds}::text[])
                                OR payload->>'user_id' = ANY(${users}::text[])
                                OR payload->>'file_id' = ANY(${files}::text[])
                                OR payload->>'email_send_id' = ANY(${sends}::text[])`;
    if (files.length) await sql`DELETE FROM files WHERE id = ANY(${files}::uuid[])`;
    if (users.length) {
      await sql`DELETE FROM files WHERE uploaded_by = ANY(${users}::uuid[])`;
      await sql`DELETE FROM users WHERE id = ANY(${users}::uuid[])`;
    }
    this.users = [];
    this.files = [];
    this.usage = [];
  }
}

type Handler = (req: NextRequest, ctx: { params: Promise<any> }) => Promise<Response>;

export async function call(
  handler: Handler,
  opts: { url?: string; method?: string; cookie?: string; json?: unknown; params?: Record<string, string>; headers?: Record<string, string> } = {},
) {
  const headers = new Headers(opts.headers);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.json !== undefined) headers.set('content-type', 'application/json');
  const req = new NextRequest(opts.url ?? 'http://localhost/api/test', {
    method: opts.method ?? (opts.json !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}
