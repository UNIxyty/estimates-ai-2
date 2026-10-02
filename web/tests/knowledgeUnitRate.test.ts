import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/db';
import { GET as listFiles } from '@/app/api/files/route';
import { GET as fileDetail, PATCH as patchFile } from '@/app/api/files/[id]/route';
import { GET as listItems, POST as addItem } from '@/app/api/files/[id]/items/route';
import { PATCH as patchItem } from '@/app/api/files/[id]/items/[itemId]/route';
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

/** A unit-rate BOQ reference with one install-only row, one supply & install row and one prelim. */
async function unitRateFile(uploadedBy: string) {
  const f = await fx.file({ uploadedBy });
  await sql`UPDATE files SET pricing_model = 'unit_rate', market = 'DE', client = 'Winthrop', end_client = 'NTT',
                             package = 'lighting', project = 'NTT FRA5', analysis = ${sql.json({ pricing_model: 'unit_rate' })}
             WHERE id = ${f}`;
  const rows = await sql<{ id: string; row_idx: number }[]>`
    INSERT INTO price_items (file_id, sheet_name, row_idx, item_text, item_norm, unit, unit_norm, qty, pricing_model,
                             install_rate, supply_rate, unit_labour, unit_material, rate_basis, package, rate_key)
    VALUES (${f}, 'Lighting', 14, 'Type - S1', 'type s1', 'no', 'no', 10, 'unit_rate', 70, NULL, 70, NULL, 'install_only', 'lighting', 'Luminaire S1'),
           (${f}, 'Lighting', 48, '2C Control Cable', '2c control cable', 'm', 'm', 100, 'unit_rate', 5, 1.25, 5, 1.25, 'supply_and_install', 'lighting', '2C Control Cable'),
           (${f}, 'Preliminaries', 26, 'Site Manager', 'site manager', 'week', 'week', 50, 'unit_rate', 2200, NULL, 2200, NULL, 'weekly', 'prelims', 'Site Manager')
    RETURNING id, row_idx`;
  return { f, s1: rows.find((r) => r.row_idx === 14)!.id, cable: rows.find((r) => r.row_idx === 48)!.id };
}

describe('knowledge: unit-rate files', () => {
  it('file list and detail carry the pricing model, market, client and install / supply rate counts', async () => {
    const { f } = await unitRateFile(alice.id);
    const r = await call(listFiles, { cookie: bob.cookie });
    const row = r.body.files.find((x: { id: string }) => x.id === f);
    expect(row).toMatchObject({ pricing_model: 'unit_rate', market: 'DE', client: 'Winthrop', package: 'lighting', project: 'NTT FRA5' });
    // the prelim's weekly rate is not an item install rate
    expect(row.counts).toMatchObject({ price_items: 3, install_rates: 2, supply_rates: 1 });
    const d = await call(fileDetail, { cookie: bob.cookie, params: { id: f } });
    expect(d.body.file.analysis).toMatchObject({ pricing_model: 'unit_rate' });
    expect(d.body.counts).toMatchObject({ install_rates: 2, supply_rates: 1 });
  });

  it('hourly files report zero install / supply rates', async () => {
    const f = await fx.file({ uploadedBy: alice.id });
    const r = await call(listFiles, { cookie: alice.cookie });
    const row = r.body.files.find((x: { id: string }) => x.id === f);
    expect(row.pricing_model).toBe('hourly_norm');
    expect(row.counts).toMatchObject({ install_rates: 0, supply_rates: 0 });
  });

  it('PATCH /api/files/{id} edits market, client and package (uploader or admin) with validation', async () => {
    const { f } = await unitRateFile(alice.id);
    const denied = await call(patchFile, { method: 'PATCH', cookie: bob.cookie, params: { id: f }, json: { market: 'NL' } });
    expect(denied.status).toBe(403);

    const ok = await call(patchFile, { method: 'PATCH', cookie: alice.cookie, params: { id: f }, json: { market: ' nl ', client: '  Winthrop Engineering ' } });
    expect(ok.status).toBe(200);
    expect(ok.body.file).toMatchObject({ market: 'NL', client: 'Winthrop Engineering', package: 'lighting', tag: 'reference_estimate' });

    for (const bad of [{ market: 'D' }, { market: 'DEUT' }, { market: 'D1' }, { client: 'x'.repeat(121) }, { package: 'plumbing' }, { foo: 1 }, {}]) {
      const r = await call(patchFile, { method: 'PATCH', cookie: alice.cookie, params: { id: f }, json: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }

    const cleared = await call(patchFile, { method: 'PATCH', cookie: admin.cookie, params: { id: f }, json: { market: null, client: '', package: 'containment' } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.file).toMatchObject({ market: null, client: null, package: 'containment' });

    // the file type PATCH keeps working and leaves the other fields alone
    const tag = await call(patchFile, { method: 'PATCH', cookie: alice.cookie, params: { id: f }, json: { tag: 'price_list' } });
    expect(tag.status).toBe(200);
    expect(tag.body.file).toMatchObject({ tag: 'price_list', package: 'containment', market: null });
  });

  it('saved numbers list install / supply rates, search the rate-card label, and accept rate overrides', async () => {
    const { f, s1, cable } = await unitRateFile(alice.id);
    const list = await call(listItems, { cookie: bob.cookie, params: { id: f }, url: 'http://localhost/api/files/x/items' });
    expect(list.body.total).toBe(3);
    const c = list.body.items.find((x: { id: string }) => x.id === cable);
    expect(c).toMatchObject({ pricing_model: 'unit_rate', rate_basis: 'supply_and_install', package: 'lighting', rate_key: '2C Control Cable' });
    expect(Number(c.install_rate)).toBe(5);
    expect(Number(c.supply_rate)).toBe(1.25);

    const byKey = await call(listItems, { cookie: bob.cookie, params: { id: f }, url: 'http://localhost/api/files/x/items?q=Luminaire' });
    expect(byKey.body.items.map((x: { id: string }) => x.id)).toEqual([s1]);

    const denied = await call(patchItem, { method: 'PATCH', cookie: bob.cookie, params: { id: f, itemId: cable }, json: { override: { install_rate: 6 } } });
    expect(denied.status).toBe(403);
    const ok = await call(patchItem, { method: 'PATCH', cookie: alice.cookie, params: { id: f, itemId: cable }, json: { override: { install_rate: 6, supply_rate: 1.5 } } });
    expect(ok.status).toBe(200);
    // mirrored into unit_labour / unit_material, which the worker also stores for unit-rate rows
    expect(ok.body.item.override).toEqual({ install_rate: 6, supply_rate: 1.5, unit_labour: 6, unit_material: 1.5 });
    const after = await call(listItems, { cookie: bob.cookie, params: { id: f }, url: 'http://localhost/api/files/x/items?q=Control' });
    expect(after.body.items[0].edited).toBe(true);
    expect(Number(after.body.items[0].effective.install_rate)).toBe(6);
    expect(Number(after.body.items[0].install_rate)).toBe(5);

    const neg = await call(patchItem, { method: 'PATCH', cookie: alice.cookie, params: { id: f, itemId: cable }, json: { override: { supply_rate: -1 } } });
    expect(neg.status).toBe(400);
    // hourly-only fields are not accepted on unit-rate rows
    const hourly = await call(patchItem, { method: 'PATCH', cookie: alice.cookie, params: { id: f, itemId: cable }, json: { override: { norm_h_per_unit: 0.2 } } });
    expect(hourly.status).toBe(400);
    const reset = await call(patchItem, { method: 'PATCH', cookie: alice.cookie, params: { id: f, itemId: cable }, json: { reset: true } });
    expect(reset.body.item.override).toBeNull();
  });

  it('hourly price items keep their override fields; install_rate is rejected there', async () => {
    const f = await fx.file({ uploadedBy: alice.id });
    const [p] = await sql<{ id: string }[]>`INSERT INTO price_items (file_id, sheet_name, row_idx, item_text, item_norm, unit_material)
                                              VALUES (${f}, 'EL', 7, 'Kabelis', 'kabelis', 1.2) RETURNING id`;
    const bad = await call(patchItem, { method: 'PATCH', cookie: alice.cookie, params: { id: f, itemId: p.id }, json: { override: { install_rate: 3 } } });
    expect(bad.status).toBe(400);
    const ok = await call(patchItem, { method: 'PATCH', cookie: alice.cookie, params: { id: f, itemId: p.id }, json: { override: { unit_material: 2 } } });
    expect(ok.status).toBe(200);
    expect(ok.body.item.override).toEqual({ unit_material: 2 });
  });

  it('rows are not added by hand to a unit-rate file', async () => {
    const { f } = await unitRateFile(alice.id);
    const r = await call(addItem, { cookie: alice.cookie, params: { id: f }, json: { item_text: 'Extra' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('not_supported_for_unit_rate');
  });
});
