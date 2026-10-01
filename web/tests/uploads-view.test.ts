import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/db';
import { GET as sheets } from '@/app/api/uploads/[id]/view/sheets/route';
import { GET as rows } from '@/app/api/uploads/[id]/view/rows/route';
import { GET as html } from '@/app/api/uploads/[id]/view/html/route';
import { GET as raw } from '@/app/api/uploads/[id]/view/raw/route';
import { GET as download } from '@/app/api/uploads/[id]/download/route';
import { Fixtures, call } from './helpers';

/** Chat attachments are viewable and downloadable by their owner only. */
const fx = new Fixtures();
let alice: Awaited<ReturnType<Fixtures['user']>>;
let bob: Awaited<ReturnType<Fixtures['user']>>;
let pdf: string;
let xlsx: string;

beforeAll(async () => {
  alice = await fx.user();
  bob = await fx.user();
  const up = async (ext: string) => (await sql<{ id: string }[]>`
    INSERT INTO uploads (user_id, original_name, ext, stored_path)
    VALUES (${alice.id}, ${`blank.${ext}`}, ${ext}, ${`uploads/${crypto.randomUUID()}/original.${ext}`}) RETURNING id`)[0].id;
  pdf = await up('pdf');
  xlsx = await up('xlsx');
});
afterAll(() => fx.cleanup());

describe('upload viewer routes', () => {
  it('require a session', async () => {
    expect((await call(download, { params: { id: pdf } })).status).toBe(401);
    expect((await call(sheets, { params: { id: xlsx } })).status).toBe(401);
  });

  it("another user's upload → 404 on every route", async () => {
    for (const [h, id] of [[sheets, xlsx], [rows, xlsx], [html, xlsx], [raw, pdf], [download, pdf]] as const) {
      const r = await call(h as never, { cookie: bob.cookie, params: { id } });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('not_found');
    }
  });

  it('owner passes the ownership check', async () => {
    const r = await call(raw, { cookie: alice.cookie, params: { id: xlsx } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('not_pdf');
    const d = await call(download, { cookie: alice.cookie, params: { id: pdf } });
    expect(d.status).toBe(404);
    expect(d.body.error).toBe('file_missing'); // row found and owned; the test file is not on disk
  });

  it('rejects a malformed id', async () => {
    expect((await call(download, { cookie: alice.cookie, params: { id: 'nope' } })).status).toBe(404);
  });
});
