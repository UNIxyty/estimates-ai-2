import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/db';
import { POST as decision } from '@/app/api/cards/[id]/decision/route';
import { Fixtures, call } from './helpers';

const fx = new Fixtures();
let owner: Awaited<ReturnType<Fixtures['user']>>;
let fileId: string;

beforeAll(async () => {
  owner = await fx.user();
  fileId = await fx.file({ tag: 'price_list' });
});
afterAll(() => fx.cleanup());

async function permissionCard(expires: 'future' | 'past' = 'future') {
  const conv = await fx.conversation(owner.id);
  const run = await fx.run(conv, owner.id, 'waiting');
  const card = await fx.card(run, conv, 'permission', 'pending', { file_id: fileId, file_name: 'Supplier.xlsx', rows: [], reason: 'test' }, expires);
  return { conv, run, card };
}

const decide = (cardId: string, action: string, data?: unknown, cookie = owner.cookie) =>
  call(decision, { method: 'POST', cookie, json: { action, data }, params: { id: cardId } });

const resumeJobs = (cardId: string) =>
  sql<{ id: number; status: string; run_after: Date; created_at: Date }[]>`
    SELECT id, status, run_after, created_at FROM jobs WHERE kind = 'resume_run' AND dedupe_key = ${`resume:${cardId}`}`;
const cardEvents = (runId: string) =>
  sql<{ seq: number }[]>`SELECT seq FROM run_events WHERE run_id = ${runId} AND type = 'card.updated' ORDER BY seq`;
const runRow = async (runId: string) =>
  (await sql<{ allowed_file_ids: string[]; denied_file_ids: string[] }[]>`SELECT allowed_file_ids, denied_file_ids FROM runs WHERE id = ${runId}`)[0];

describe('permission card: allow / deny idempotency', () => {
  it('a repeated allow changes state once, enqueues one delayed resume_run and appends the id once', async () => {
    const { run, card } = await permissionCard();
    const a = await decide(card, 'allow');
    const b = await decide(card, 'allow');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.card.status).toBe('approved');
    expect(b.body.card.status).toBe('approved');
    expect(a.body.card.decision).toEqual({ action: 'allow', data: {} });
    expect(a.body.card.decided_by).toBe(owner.id);

    const jobs = await resumeJobs(card);
    expect(jobs).toHaveLength(1);
    const delay = (jobs[0].run_after.getTime() - jobs[0].created_at.getTime()) / 1000;
    expect(delay).toBeGreaterThanOrEqual(9);
    expect(delay).toBeLessThanOrEqual(11);
    expect((await runRow(run)).allowed_file_ids).toEqual([fileId]);
    expect(await cardEvents(run)).toHaveLength(1);
  });

  it('two concurrent decisions (allow + allow, allow + deny) produce exactly one state change', async () => {
    const { run, card } = await permissionCard();
    const results = await Promise.all([decide(card, 'allow'), decide(card, 'allow')]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await resumeJobs(card)).toHaveLength(1);
    expect((await runRow(run)).allowed_file_ids).toEqual([fileId]);
    expect(await cardEvents(run)).toHaveLength(1);

    const second = await permissionCard();
    const mixed = await Promise.all([decide(second.card, 'allow'), decide(second.card, 'deny')]);
    const final = (await sql<{ status: string }[]>`SELECT status FROM cards WHERE id = ${second.card}`)[0].status;
    expect(['approved', 'denied']).toContain(final);
    expect(mixed.every((r) => r.body.card.status === final)).toBe(true);
    expect(await resumeJobs(second.card)).toHaveLength(1);
    const rr = await runRow(second.run);
    expect(rr.allowed_file_ids.length + rr.denied_file_ids.length).toBe(1);
    expect(await cardEvents(second.run)).toHaveLength(1);
  });

  it('deny appends to denied_file_ids', async () => {
    const { run, card } = await permissionCard();
    const r = await decide(card, 'deny');
    expect(r.body.card.status).toBe('denied');
    expect(await runRow(run)).toEqual({ allowed_file_ids: [], denied_file_ids: [fileId] });
  });
});

describe('permission card: undo', () => {
  it('undo within the window cancels the queued job and reverts the card and the allowed id', async () => {
    const { run, card } = await permissionCard();
    await decide(card, 'allow');
    const u = await decide(card, 'undo');
    expect(u.status).toBe(200);
    expect(u.body.card.status).toBe('pending');
    expect(u.body.card.decision).toBeNull();
    expect(u.body.card.decided_at).toBeNull();
    const jobs = await resumeJobs(card);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('cancelled');
    expect((await runRow(run)).allowed_file_ids).toEqual([]);
    // A repeated undo is a no-op.
    const again = await decide(card, 'undo');
    expect(again.status).toBe(200);
    expect(again.body.card.status).toBe('pending');
    expect(await cardEvents(run)).toHaveLength(2);
    // Deciding again after an undo works and enqueues a fresh job.
    const re = await decide(card, 'deny');
    expect(re.body.card.status).toBe('denied');
    expect((await resumeJobs(card)).filter((j) => j.status === 'queued')).toHaveLength(1);
  });

  it('undo after the job started → 409 too_late and nothing changes', async () => {
    const { run, card } = await permissionCard();
    await decide(card, 'allow');
    await sql`UPDATE jobs SET status = 'running', locked_at = now() WHERE dedupe_key = ${`resume:${card}`}`;
    const u = await decide(card, 'undo');
    expect(u.status).toBe(409);
    expect(u.body.error).toBe('too_late');
    expect(u.body.card.status).toBe('approved');
    expect((await runRow(run)).allowed_file_ids).toEqual([fileId]);
  });

  it('undo after the undo window → 409 too_late', async () => {
    const { card } = await permissionCard();
    await decide(card, 'allow');
    await sql`UPDATE cards SET decided_at = now() - interval '1 minute' WHERE id = ${card}`;
    const u = await decide(card, 'undo');
    expect(u.status).toBe(409);
    expect(u.body.error).toBe('too_late');
    expect((await resumeJobs(card))[0].status).toBe('queued');
  });
});

describe('permission card: expiry and ask_again', () => {
  it('a decision on an expired card → 409 expired; ask_again works once', async () => {
    const { run, card } = await permissionCard('past');
    const a = await decide(card, 'allow');
    expect(a.status).toBe(409);
    expect(a.body.error).toBe('expired');
    expect(a.body.card.status).toBe('expired');
    expect(await resumeJobs(card)).toHaveLength(0);
    expect((await runRow(run)).allowed_file_ids).toEqual([]);

    const eventsBefore = (await cardEvents(run)).length;
    const [x, y] = await Promise.all([decide(card, 'ask_again'), decide(card, 'ask_again')]);
    expect(x.status).toBe(200);
    expect(y.status).toBe(200);
    expect(x.body.card.status).toBe('pending');
    expect(new Date(x.body.card.expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(x.body.card.expires_at).toBe(y.body.card.expires_at);
    expect((await cardEvents(run)).length).toBe(eventsBefore + 1);

    // A later ask_again on a live pending card is a no-op.
    const z = await decide(card, 'ask_again');
    expect(z.body.card.expires_at).toBe(x.body.card.expires_at);
    expect((await cardEvents(run)).length).toBe(eventsBefore + 1);

    const ok = await decide(card, 'allow');
    expect(ok.status).toBe(200);
    expect(ok.body.card.status).toBe('approved');
  });

  it('rejects an action that does not belong to the card kind', async () => {
    const { card } = await permissionCard();
    const r = await decide(card, 'generate');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_action');
  });
});

describe('email card: retry idempotency', () => {
  async function failedEmailCard(status = 'failed') {
    const conv = await fx.conversation(owner.id);
    const run = await fx.run(conv, owner.id, 'done');
    const [es] = await sql<{ id: string }[]>`
      INSERT INTO email_sends (run_id, user_id, to_email, idempotency_key, status, error)
      VALUES (${run}, ${owner.id}, 'client@example.com', ${crypto.randomUUID()}, 'failed', 'boom') RETURNING id`;
    const card = await fx.card(run, conv, 'email', status, { to: 'client@example.com', email_send_id: es.id }, 'none');
    await sql`UPDATE email_sends SET card_id = ${card} WHERE id = ${es.id}`;
    return { run, card, emailSendId: es.id };
  }
  const sendJobs = (id: string) => sql`SELECT id, status FROM jobs WHERE kind = 'send_email' AND payload->>'email_send_id' = ${id}`;

  it('two concurrent retries enqueue exactly one send_email job', async () => {
    const { card, emailSendId, run } = await failedEmailCard();
    const [a, b] = await Promise.all([decide(card, 'retry'), decide(card, 'retry')]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.card.status).toBe('sending');
    expect(b.body.card.status).toBe('sending');
    expect(await sendJobs(emailSendId)).toHaveLength(1);
    const es = (await sql<{ status: string }[]>`SELECT status FROM email_sends WHERE id = ${emailSendId}`)[0];
    expect(es.status).toBe('queued');
    expect(await cardEvents(run)).toHaveLength(1);
  });

  it('retry on a card that is not failed is a no-op', async () => {
    const { card, emailSendId } = await failedEmailCard('sending');
    const r = await decide(card, 'retry');
    expect(r.status).toBe(200);
    expect(r.body.card.status).toBe('sending');
    expect(await sendJobs(emailSendId)).toHaveLength(0);
    const done = await failedEmailCard('done');
    const r2 = await decide(done.card, 'retry');
    expect(r2.body.card.status).toBe('done');
    expect(await sendJobs(done.emailSendId)).toHaveLength(0);
  });
});

describe('other card kinds', () => {
  it('clarify answer stores {action, data:{answers}} and enqueues an immediate resume once', async () => {
    const conv = await fx.conversation(owner.id);
    const run = await fx.run(conv, owner.id, 'waiting');
    const card = await fx.card(run, conv, 'clarify', 'pending', { questions: [{ id: 'sheets', text: 'Which sheets?', options: ['Elektro', 'Vājstrāva'] }] }, 'none');
    const answers = { sheets: ['Elektro'] };
    const [a, b] = await Promise.all([decide(card, 'answer', { answers }), decide(card, 'answer', { answers })]);
    expect(a.body.card.status).toBe('answered');
    expect(b.body.card.status).toBe('answered');
    expect(a.body.card.decision).toEqual({ action: 'answer', data: { answers } });
    const jobs = await resumeJobs(card);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].run_after.getTime() - jobs[0].created_at.getTime()).toBeLessThan(1000);
  });

  it('structure change requires instructions; cost_cap continue raises the cap once', async () => {
    const conv = await fx.conversation(owner.id);
    const run = await fx.run(conv, owner.id, 'waiting');
    const s = await fx.card(run, conv, 'structure', 'pending', { sheets: [] }, 'none');
    expect((await decide(s, 'change', {})).status).toBe(400);
    const ch = await decide(s, 'change', { instructions: 'Add a lighting section' });
    expect(ch.body.card.status).toBe('changed');
    expect(ch.body.card.decision).toEqual({ action: 'change', data: { instructions: 'Add a lighting section' } });

    const conv2 = await fx.conversation(owner.id);
    const run2 = await fx.run(conv2, owner.id, 'paused_cost');
    const cc = await fx.card(run2, conv2, 'cost_cap', 'pending', { run_cost_usd: 2.1, cap_usd: 2 }, 'none');
    await Promise.all([decide(cc, 'continue'), decide(cc, 'continue')]);
    const r = (await sql<{ cost_cap_usd: number }[]>`SELECT cost_cap_usd FROM runs WHERE id = ${run2}`)[0];
    expect(r.cost_cap_usd).toBe(4);
    expect(await resumeJobs(cc)).toHaveLength(1);
  });
});
