import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/db';
import { POST as postMessage } from '@/app/api/conversations/[id]/messages/route';
import { POST as stop } from '@/app/api/runs/[id]/stop/route';
import { Fixtures, call } from './helpers';

const fx = new Fixtures();
let user: Awaited<ReturnType<Fixtures['user']>>;
let savedBudget: unknown = undefined;

beforeAll(async () => {
  user = await fx.user();
  const b = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'budget'`;
  savedBudget = b[0]?.value;
});
afterAll(async () => {
  await restoreBudget();
  await fx.cleanup();
});

async function restoreBudget() {
  if (savedBudget === undefined) await sql`DELETE FROM settings WHERE key = 'budget'`;
  else await sql`UPDATE settings SET value = ${sql.json(savedBudget as never)} WHERE key = 'budget'`;
}
async function setBudget(over_action: 'pause' | 'fast_only' | 'warn') {
  await sql`INSERT INTO settings (key, value) VALUES ('budget', ${sql.json({ monthly_usd: 1, alert_pct: 80, over_action })})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

const send = (convId: string, body: Record<string, unknown> = { text: 'Price this blank' }) =>
  call(postMessage, { method: 'POST', cookie: user.cookie, json: body, params: { id: convId } });
const counts = async (convId: string) =>
  (await sql<{ runs: number; msgs: number; jobs: number }[]>`
    SELECT (SELECT count(*)::int FROM runs WHERE conversation_id = ${convId}) AS runs,
           (SELECT count(*)::int FROM messages WHERE conversation_id = ${convId}) AS msgs,
           (SELECT count(*)::int FROM jobs WHERE kind = 'run_agent'
              AND payload->>'run_id' IN (SELECT id::text FROM runs WHERE conversation_id = ${convId})) AS jobs`)[0];

describe('chat lock', () => {
  it('409 chat_locked while no reference estimate is analysed', async () => {
    const pre = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM files
                                             WHERE tag = 'reference_estimate' AND status = 'analysed' AND deleted_at IS NULL`;
    expect(pre[0].n, 'test DB must start without analysed reference estimates').toBe(0);
    const conv = await fx.conversation(user.id);
    // Analysed price list / not-yet-analysed reference estimate do not unlock chat.
    await fx.file({ tag: 'price_list', status: 'analysed' });
    const pending = await fx.file({ tag: 'reference_estimate', status: 'analysing' });
    const r = await send(conv);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('chat_locked');
    expect(await counts(conv)).toEqual({ runs: 0, msgs: 0, jobs: 0 });

    await sql`UPDATE files SET status = 'analysed' WHERE id = ${pending}`;
    const ok = await send(conv);
    expect(ok.status).toBe(201);
  });
});

describe('posting a message', () => {
  let refFile: string;
  beforeAll(async () => {
    refFile = await fx.file({ tag: 'reference_estimate', status: 'analysed' });
    await fx.usageRow(5, user.id); // $5 spent this month vs a $1 budget → over
  });
  afterEach(restoreBudget);

  it('creates message + run + run_agent job, titles the conversation, blocks a second concurrent run', async () => {
    await sql`DELETE FROM settings WHERE key = 'budget'`;
    const conv = await fx.conversation(user.id);
    const r = await send(conv, { text: 'Please price the attached electrical blank for the school project in Riga', reference_ids: [refFile] });
    expect(r.status).toBe(201);
    expect(r.body.message.role).toBe('user');
    expect(r.body.run.status).toBe('queued');
    expect(r.body.run.selected_file_ids).toEqual([refFile]);
    expect(r.body.run.allowed_file_ids).toEqual([refFile]);
    expect(Number(r.body.run.cost_cap_usd)).toBe(2);
    expect(r.body.run.tier_override).toBeNull();
    const job = await sql`SELECT * FROM jobs WHERE dedupe_key = ${`run:${r.body.run.id}`}`;
    expect(job).toHaveLength(1);
    const c = (await sql<{ title: string }[]>`SELECT title FROM conversations WHERE id = ${conv}`)[0];
    expect(c.title.length).toBeLessThanOrEqual(61);
    expect(c.title.startsWith('Please price the attached')).toBe(true);

    const again = await send(conv);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('run_active');

    // waiting / paused_cost runs do not block a new message.
    await sql`UPDATE runs SET status = 'waiting' WHERE id = ${r.body.run.id}`;
    const third = await send(conv, { text: 'another question' });
    expect(third.status).toBe(201);
  });

  it('with no references selected, allowed_file_ids = all analysed files', async () => {
    const conv = await fx.conversation(user.id);
    const r = await send(conv);
    expect(r.status).toBe(201);
    expect(r.body.run.selected_file_ids).toEqual([]);
    expect(r.body.run.allowed_file_ids).toContain(refFile);
  });

  it('rejects references that are not analysed and attachments of another user', async () => {
    const conv = await fx.conversation(user.id);
    const notAnalysed = await fx.file({ tag: 'price_list', status: 'queued' });
    const r = await send(conv, { text: 'x', reference_ids: [notAnalysed] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_reference');
    const other = await fx.user();
    const [up] = await sql<{ id: string }[]>`INSERT INTO uploads (user_id, original_name, ext, stored_path)
                                              VALUES (${other.id}, 'b.xlsx', 'xlsx', '/x') RETURNING id`;
    const r2 = await send(conv, { text: 'x', attachment_ids: [up.id] });
    expect(r2.status).toBe(400);
    expect(r2.body.error).toBe('invalid_attachment');
    expect(await counts(conv)).toEqual({ runs: 0, msgs: 0, jobs: 0 });
  });

  it('budget over + pause → 402 budget_paused, no run and no job', async () => {
    await setBudget('pause');
    const conv = await fx.conversation(user.id);
    const r = await send(conv);
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('budget_paused');
    expect(await counts(conv)).toEqual({ runs: 0, msgs: 0, jobs: 0 });
  });

  it("budget over + fast_only → run created with tier_override 'fast'", async () => {
    await setBudget('fast_only');
    const conv = await fx.conversation(user.id);
    const r = await send(conv);
    expect(r.status).toBe(201);
    expect(r.body.run.tier_override).toBe('fast');
    expect(await counts(conv)).toEqual({ runs: 1, msgs: 1, jobs: 1 });
  });

  it('budget over + warn → run created normally', async () => {
    await setBudget('warn');
    const conv = await fx.conversation(user.id);
    const r = await send(conv);
    expect(r.status).toBe(201);
    expect(r.body.run.tier_override).toBeNull();
    expect(await counts(conv)).toEqual({ runs: 1, msgs: 1, jobs: 1 });
  });
});

describe('stop', () => {
  it('a queued run is cancelled immediately with a terminal run.status event; a running one is only flagged', async () => {
    const conv = await fx.conversation(user.id);
    const queued = await fx.run(conv, user.id, 'queued');
    const r = await call(stop, { method: 'POST', cookie: user.cookie, params: { id: queued } });
    expect(r.status).toBe(200);
    expect(r.body.run.status).toBe('cancelled');
    expect(r.body.run.cancel_requested).toBe(true);
    const ev = await sql`SELECT type, payload FROM run_events WHERE run_id = ${queued}`;
    expect(ev).toEqual([{ type: 'run.status', payload: { status: 'cancelled' } }]);

    const running = await fx.run(conv, user.id, 'running');
    const r2 = await call(stop, { method: 'POST', cookie: user.cookie, params: { id: running } });
    expect(r2.body.run.status).toBe('running');
    expect(r2.body.run.cancel_requested).toBe(true);
    expect(await sql`SELECT 1 FROM run_events WHERE run_id = ${running}`).toHaveLength(0);
  });
});
