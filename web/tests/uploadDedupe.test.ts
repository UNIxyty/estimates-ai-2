import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { POST as uploadFile } from '@/app/api/files/route';
import { Fixtures } from './helpers';

const fx = new Fixtures();
let alice: Awaited<ReturnType<Fixtures['user']>>;
const created: string[] = [];

beforeAll(async () => { alice = await fx.user(); });
afterAll(async () => {
  if (created.length) await sql`DELETE FROM files WHERE id = ANY(${created}::uuid[])`;
  await sql`DELETE FROM jobs WHERE kind = 'ingest_file' AND payload->>'file_id' = ANY(${created}::text[])`;
  await fx.cleanup();
});

function upload(bytes: Uint8Array, name: string) {
  const fd = new FormData();
  fd.set('file', new File([bytes.buffer as ArrayBuffer], name, { type: 'application/octet-stream' }));
  fd.set('tag', 'reference_estimate');
  const req = new NextRequest('http://localhost/api/files', { method: 'POST', body: fd, headers: { cookie: alice.cookie } });
  return uploadFile(req, { params: Promise.resolve({}) } as never);
}

describe('knowledge upload: identical files are stored once', () => {
  it('returns the existing file with duplicate = true for the same bytes under another name', async () => {
    const bytes = new TextEncoder().encode(`PK fake workbook ${Date.now()} ${Math.random()}`);
    const first = await upload(bytes, '3726-NTTFRA5-GS-SP-BOQ-Revision1.xls');
    expect(first.status).toBe(201);
    const a = await first.json();
    created.push(a.file.id);
    expect(a.duplicate).toBe(false);

    const second = await upload(bytes, '3726-NTTFRA5-GS-SP-BOQ-Revision1_2.xls');
    expect(second.status).toBe(200);
    const b = await second.json();
    expect(b.duplicate).toBe(true);
    expect(b.file.id).toBe(a.file.id);
    expect(await sql`SELECT 1 FROM files WHERE sha256 = ${a.file.sha256} AND deleted_at IS NULL`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM jobs WHERE kind = 'ingest_file' AND payload->>'file_id' = ${a.file.id}`).toHaveLength(1);
  });
});
