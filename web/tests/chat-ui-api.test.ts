import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/db';
import { GET as conversation } from '@/app/api/conversations/[id]/route';
import { GET as picker } from '@/app/api/picker/route';
import { POST as decision } from '@/app/api/cards/[id]/decision/route';
import { Fixtures, call } from './helpers';

/** Additive API fields the chat UI relies on. */
const fx = new Fixtures();
let owner: Awaited<ReturnType<Fixtures['user']>>;

beforeAll(async () => {
  owner = await fx.user();
});
afterAll(() => fx.cleanup());

describe('GET /api/conversations/{id} extras', () => {
  it('returns runs, step events (last progress per step only), uploads and references', async () => {
    const conv = await fx.conversation(owner.id);
    const run = await fx.run(conv, owner.id, 'done');
    const ref = await fx.file({ tag: 'reference_estimate' });
    await sql`INSERT INTO messages (conversation_id, run_id, role, content, reference_ids) VALUES (${conv}, ${run}, 'user', 'hi', ${[ref]}::uuid[])`;
    await sql`INSERT INTO uploads (user_id, conversation_id, original_name, ext, stored_path) VALUES (${owner.id}, ${conv}, 'blank.xlsx', 'xlsx', '/x')`;
    const ev = [
      ['step.started', { step_id: 'p', label: 'Pricing', total: 10 }],
      ['step.progress', { step_id: 'p', done: 3, total: 10 }],
      ['step.progress', { step_id: 'p', done: 7, total: 10 }],
      ['text.delta', { message_id: 'm', delta: 'x' }],
      ['step.done', { step_id: 'p', summary: 'ok' }],
    ] as const;
    let seq = 0;
    for (const [type, payload] of ev) await sql`INSERT INTO run_events (run_id, seq, type, payload) VALUES (${run}, ${++seq}, ${type}, ${sql.json(payload as never)})`;

    const r = await call(conversation, { cookie: owner.cookie, params: { id: conv } });
    expect(r.status).toBe(200);
    expect(r.body.runs.map((x: { id: string }) => x.id)).toEqual([run]);
    expect(r.body.uploads.map((u: { original_name: string }) => u.original_name)).toEqual(['blank.xlsx']);
    expect(r.body.references.map((f: { id: string }) => f.id)).toEqual([ref]);
    const types = r.body.step_events.map((e: { type: string; payload: { done?: number } }) => [e.type, e.payload.done ?? null]);
    expect(types).toEqual([['step.started', null], ['step.progress', 7], ['step.done', null]]);
  });
});

describe('GET /api/picker?all=1', () => {
  it('also lists files that are not analysed, with their status', async () => {
    const failed = await fx.file({ tag: 'price_list', status: 'failed' });
    const plain = await call(picker, { url: 'http://localhost/api/picker', cookie: owner.cookie });
    const all = await call(picker, { url: 'http://localhost/api/picker?all=1', cookie: owner.cookie });
    const ids = (b: { groups: { files: { id: string; status?: string }[] }[] }) => b.groups.flatMap((g) => g.files);
    expect(ids(plain.body).some((f) => f.id === failed)).toBe(false);
    expect(ids(all.body).find((f) => f.id === failed)?.status).toBe('failed');
  });
});

describe('structure card: Generate with a language', () => {
  it('stores the chosen language in the decision and reports undo_seconds', async () => {
    const conv = await fx.conversation(owner.id);
    const run = await fx.run(conv, owner.id, 'waiting');
    const card = await fx.card(run, conv, 'structure', 'pending', { template_name: 'T.xlsx', language: 'LV', sheets: [] }, 'none');
    const r = await call(decision, { method: 'POST', cookie: owner.cookie, json: { action: 'generate', data: { language: 'en' } }, params: { id: card } });
    expect(r.status).toBe(200);
    expect(r.body.card.status).toBe('generating');
    expect(r.body.card.decision).toEqual({ action: 'generate', data: { language: 'EN' } });
    expect(typeof r.body.undo_seconds).toBe('number');
  });
});
