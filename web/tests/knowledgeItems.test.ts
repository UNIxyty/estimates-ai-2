import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/db';
import { GET as listFiles } from '@/app/api/files/route';
import { GET as fileDetail } from '@/app/api/files/[id]/route';
import { GET as listItems, POST as addItem } from '@/app/api/files/[id]/items/route';
import { DELETE as deleteItem, PATCH as patchItem } from '@/app/api/files/[id]/items/[itemId]/route';
import { normaliseItemText, USER_ROWS_SHEET } from '@/lib/knowledge';
import { Fixtures, call } from './helpers';

const fx = new Fixtures();
let admin: Awaited<ReturnType<Fixtures['user']>>;
let alice: Awaited<ReturnType<Fixtures['user']>>;
let bob: Awaited<ReturnType<Fixtures['user']>>;

beforeAll(async () => {
  admin = await fx.user({ role: 'admin' });
  alice = await fx.user();
  bob = await fx.user();
});
afterAll(() => fx.cleanup());

describe('knowledge: saved numbers can be added and deleted by hand', () => {
  it('adds a price item on the "Added by user" sheet, lists it first, and deletes it', async () => {
    const f = await fx.file({ uploadedBy: alice.id, tag: 'reference_estimate' });
    await sql`UPDATE files SET summary = ${sql.json({ currency: 'EUR', hourly_rates: [18] })} WHERE id = ${f}`;
    await sql`INSERT INTO price_items (file_id, sheet_name, row_idx, item_text, item_norm, unit, unit_material)
              VALUES (${f}, 'EL', 7, 'Kabelis', 'kabelis', 'm', 1.2)`;

    const denied = await call(addItem, { cookie: bob.cookie, params: { id: f }, json: { item_text: 'X' } });
    expect(denied.status).toBe(403);

    const r = await call(addItem, { cookie: alice.cookie, params: { id: f }, json: { item_text: 'Kabelis NYM 3×1,5', unit: 'm', norm_h_per_unit: 0.07, unit_material: 1.25 } });
    expect(r.status).toBe(201);
    expect(r.body.item.sheet_name).toBe(USER_ROWS_SHEET);
    expect(r.body.item.row_idx).toBe(1);
    expect(Number(r.body.item.unit_labour)).toBeCloseTo(1.26, 4); // 0.07 h × 18 EUR/h
    const second = await call(addItem, { cookie: admin.cookie, params: { id: f }, json: { item_text: 'Second' } });
    expect(second.body.item.row_idx).toBe(2);

    const list = await call(listItems, { cookie: bob.cookie, params: { id: f }, url: 'http://localhost/api/files/x/items' });
    expect(list.body.total).toBe(3);
    expect(list.body.items[0].attrs.user_added).toBe(true);

    const patched = await call(patchItem, { method: 'PATCH', cookie: alice.cookie, params: { id: f, itemId: r.body.item.id }, json: { override: { unit_material: 2 } } });
    expect(patched.status).toBe(200);

    expect((await call(deleteItem, { method: 'DELETE', cookie: bob.cookie, params: { id: f, itemId: r.body.item.id } })).status).toBe(403);
    expect((await call(deleteItem, { method: 'DELETE', cookie: alice.cookie, params: { id: f, itemId: r.body.item.id } })).status).toBe(200);
    expect((await call(deleteItem, { method: 'DELETE', cookie: alice.cookie, params: { id: f, itemId: r.body.item.id } })).status).toBe(404);
    expect(await sql`SELECT 1 FROM price_items WHERE file_id = ${f}`).toHaveLength(2);
  });

  it('adds a norm to an hourly-norms file (hours required)', async () => {
    const f = await fx.file({ uploadedBy: alice.id, tag: 'hourly_norms' });
    const bad = await call(addItem, { cookie: alice.cookie, params: { id: f }, json: { item_text: 'Socket' } });
    expect(bad.status).toBe(400);
    const r = await call(addItem, { cookie: alice.cookie, params: { id: f }, json: { item_text: 'Socket', unit: 'pcs', hours: 0.35 } });
    expect(r.status).toBe(201);
    expect(r.body.kind).toBe('norms');
    const d = await call(deleteItem, { method: 'DELETE', cookie: admin.cookie, params: { id: f, itemId: r.body.item.id } });
    expect(d.status).toBe(200);
  });

  it('rejects unknown fields', async () => {
    const f = await fx.file({ uploadedBy: alice.id });
    const r = await call(addItem, { cookie: alice.cookie, params: { id: f }, json: { item_text: 'A', embedding: [1] } });
    expect(r.status).toBe(400);
  });
});

describe('knowledge: list and detail extras', () => {
  it('file list carries extracted / used-in counts; detail carries the analysis cost', async () => {
    const f = await fx.file({ uploadedBy: alice.id });
    await sql`INSERT INTO price_items (file_id, sheet_name, row_idx, item_text, item_norm, norm_h_per_unit)
              VALUES (${f}, 'EL', 7, 'A', 'a', 0.5), (${f}, 'EL', 8, 'B', 'b', NULL)`;
    const r = await call(listFiles, { cookie: bob.cookie });
    const row = r.body.files.find((x: { id: string }) => x.id === f);
    expect(row.counts).toMatchObject({ price_items: 2, price_norms: 1, norms: 0, notes: 0, used_in: 0 });
    const d = await call(fileDetail, { cookie: bob.cookie, params: { id: f } });
    expect(d.body.analysis).toMatchObject({ cost_usd: 0, calls: 0 });
  });

  it('normalises item text like the worker', () => {
    expect(normaliseItemText('Kabelis NYM 3×1,5 mm²')).toBe('kabelis nym 3x1.5 mm2');
    expect(normaliseItemText('Rozete  2P+E, 16A (IP44)')).toBe('rozete 2p+e 16a ip44');
  });
});
