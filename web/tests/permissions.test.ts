import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/db';
import { POST as invite } from '@/app/api/users/invite/route';
import { GET as listUsers } from '@/app/api/users/route';
import { PATCH as patchUser, DELETE as deleteUser } from '@/app/api/users/[id]/route';
import { PUT as putRouting, GET as getRouting } from '@/app/api/settings/routing/route';
import { PUT as putBudget } from '@/app/api/settings/budget/route';
import { GET as getConversation } from '@/app/api/conversations/[id]/route';
import { POST as postMessage } from '@/app/api/conversations/[id]/messages/route';
import { GET as runEvents } from '@/app/api/runs/[id]/events/route';
import { POST as stopRun } from '@/app/api/runs/[id]/stop/route';
import { POST as decision } from '@/app/api/cards/[id]/decision/route';
import { GET as getDocument } from '@/app/api/documents/[id]/route';
import { GET as downloadDocument } from '@/app/api/documents/[id]/download/route';
import { GET as docRow } from '@/app/api/documents/[id]/rows/[sheet]/[row]/route';
import { GET as listFiles } from '@/app/api/files/route';
import { DELETE as deleteFile } from '@/app/api/files/[id]/route';
import { GET as me } from '@/app/api/auth/me/route';
import { GET as usage } from '@/app/api/usage/route';
import { Fixtures, call } from './helpers';

const fx = new Fixtures();
let admin: Awaited<ReturnType<Fixtures['user']>>;
let alice: Awaited<ReturnType<Fixtures['user']>>;
let bob: Awaited<ReturnType<Fixtures['user']>>;
let a: { conv: string; run: string; card: string; doc: string };

beforeAll(async () => {
  admin = await fx.user({ role: 'admin' });
  alice = await fx.user();
  bob = await fx.user();
  const conv = await fx.conversation(alice.id);
  const run = await fx.run(conv, alice.id, 'waiting');
  const card = await fx.card(run, conv, 'clarify', 'pending', { questions: [] }, 'none');
  const doc = await fx.document(conv, alice.id, run);
  a = { conv, run, card, doc };
});
afterAll(() => fx.cleanup());

const routingBody = {
  routing: {
    tiers: { fast: { model_id: 'f', enabled: true }, standard: { model_id: 's', enabled: true }, advanced: { model_id: 'a', enabled: true } },
    tasks: { simple_question: 'fast' },
    overrides: {},
    escalate_when_unsure: true,
  },
};

describe('unauthenticated → 401', () => {
  it.each([
    ['me', me, {}],
    ['files', listFiles, {}],
    ['usage', usage, {}],
    ['conversation', getConversation, { id: '00000000-0000-0000-0000-000000000000' }],
  ] as const)('%s', async (_n, h, params) => {
    const r = await call(h as never, { params: params as Record<string, string> });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('unauthenticated');
  });

  it('a garbage cookie is 401 too', async () => {
    expect((await call(me, { cookie: 'est_session=not-a-real-token' })).status).toBe(401);
  });

  it('a disabled user’s session stops working', async () => {
    const u = await fx.user();
    expect((await call(me, { cookie: u.cookie })).status).toBe(200);
    await sql`UPDATE users SET status = 'disabled' WHERE id = ${u.id}`;
    expect((await call(me, { cookie: u.cookie })).status).toBe(401);
  });
});

describe('admin-only endpoints → 403 for estimators', () => {
  it('users/invite, users list, user patch, PUT routing, PUT budget', async () => {
    expect((await call(invite, { method: 'POST', cookie: alice.cookie, json: { email: 'x@test.local', name: 'X', role: 'admin' } })).status).toBe(403);
    expect((await call(listUsers, { cookie: alice.cookie })).status).toBe(403);
    expect((await call(patchUser, { method: 'PATCH', cookie: alice.cookie, json: { role: 'admin' }, params: { id: alice.id } })).status).toBe(403);
    expect((await call(putRouting, { method: 'PUT', cookie: alice.cookie, json: routingBody })).status).toBe(403);
    expect((await call(putBudget, { method: 'PUT', cookie: alice.cookie, json: { monthly_usd: 10, alert_pct: 80, over_action: 'warn' } })).status).toBe(403);
    // Reading routing is allowed.
    expect((await call(getRouting, { cookie: alice.cookie })).status).toBe(200);
    expect((await sql`SELECT 1 FROM users WHERE email = 'x@test.local'`).length).toBe(0);
  });

  it('admins can invite (job queued) and validation errors are 400', async () => {
    const email = `inv-${crypto.randomUUID()}@test.local`;
    const r = await call(invite, { method: 'POST', cookie: admin.cookie, json: { email, name: 'New', role: 'estimator' } });
    expect(r.status).toBe(201);
    fx.users.push(r.body.user.id);
    expect(r.body.user.status).toBe('invited');
    const jobs = await sql`SELECT payload FROM jobs WHERE kind = 'send_auth_email' AND payload->>'user_id' = ${r.body.user.id}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.kind).toBe('invite');
    expect(jobs[0].payload.url).toMatch(/^http:\/\/localhost:3000\/set-password\?token=/);
    const bad = await call(putRouting, { method: 'PUT', cookie: admin.cookie, json: { routing: { tiers: {} } } });
    expect(bad.status).toBe(400);
  });

  it('the last active admin cannot be demoted or disabled', async () => {
    const admins = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'`;
    expect(admins[0].n).toBe(1);
    const demote = await call(patchUser, { method: 'PATCH', cookie: admin.cookie, json: { role: 'estimator' }, params: { id: admin.id } });
    expect(demote.status).toBe(409);
    expect(demote.body.error).toBe('last_admin');
    const disable = await call(deleteUser, { method: 'DELETE', cookie: admin.cookie, params: { id: admin.id } });
    expect(disable.status).toBe(409);
    // With a second admin, demoting the first is allowed; disabling kills sessions.
    const second = await fx.user({ role: 'admin' });
    const ok = await call(patchUser, { method: 'PATCH', cookie: second.cookie, json: { role: 'estimator' }, params: { id: admin.id } });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe('estimator');
    const blocked = await call(deleteUser, { method: 'DELETE', cookie: second.cookie, params: { id: second.id } });
    expect(blocked.status).toBe(409);
    await sql`UPDATE users SET role = 'admin' WHERE id = ${admin.id}`;
    const dis = await call(deleteUser, { method: 'DELETE', cookie: admin.cookie, params: { id: second.id } });
    expect(dis.status).toBe(200);
    expect(dis.body.user.status).toBe('disabled');
    expect(await sql`SELECT 1 FROM sessions WHERE user_id = ${second.id}`).toHaveLength(0);
  });
});

describe("another user's resources → 404", () => {
  it('conversation, messages, run events, stop, card, document, provenance row', async () => {
    const b = bob.cookie;
    expect((await call(getConversation, { cookie: b, params: { id: a.conv } })).status).toBe(404);
    expect((await call(postMessage, { method: 'POST', cookie: b, json: { text: 'hi' }, params: { id: a.conv } })).status).toBe(404);
    expect((await call(runEvents, { cookie: b, params: { id: a.run } })).status).toBe(404);
    expect((await call(stopRun, { method: 'POST', cookie: b, params: { id: a.run } })).status).toBe(404);
    expect((await call(decision, { method: 'POST', cookie: b, json: { action: 'answer', data: { answers: {} } }, params: { id: a.card } })).status).toBe(404);
    expect((await call(getDocument, { cookie: b, params: { id: a.doc } })).status).toBe(404);
    expect((await call(downloadDocument, { cookie: b, params: { id: a.doc } })).status).toBe(404);
    expect((await call(docRow, { cookie: b, params: { id: a.doc, sheet: 'Sheet1', row: '2' } })).status).toBe(404);
    // Nothing changed for Alice.
    const card = (await sql<{ status: string }[]>`SELECT status FROM cards WHERE id = ${a.card}`)[0];
    expect(card.status).toBe('pending');
    const run = (await sql<{ cancel_requested: boolean }[]>`SELECT cancel_requested FROM runs WHERE id = ${a.run}`)[0];
    expect(run.cancel_requested).toBe(false);
    // The owner can read them.
    expect((await call(getConversation, { cookie: alice.cookie, params: { id: a.conv } })).status).toBe(200);
    expect((await call(getDocument, { cookie: alice.cookie, params: { id: a.doc } })).status).toBe(200);
  });

  it('non-uuid ids are 404 without a DB error', async () => {
    expect((await call(getConversation, { cookie: alice.cookie, params: { id: 'nope' } })).status).toBe(404);
  });

  it('knowledge files: only the uploader or an admin may delete', async () => {
    const f = await fx.file({ uploadedBy: alice.id, tag: 'other' });
    const r = await call(deleteFile, { method: 'DELETE', cookie: bob.cookie, params: { id: f } });
    expect(r.status).toBe(403);
    const ok = await call(deleteFile, { method: 'DELETE', cookie: admin.cookie, params: { id: f } });
    expect(ok.status).toBe(200);
    expect(await sql`SELECT 1 FROM files WHERE id = ${f}`).toHaveLength(0);
  });
});
