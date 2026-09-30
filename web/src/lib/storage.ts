import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { env, MAX_UPLOAD_BYTES } from './env';
import { HttpError, badRequest, contentDisposition, notFound } from './http';

export const KNOWLEDGE_EXTS = ['xlsx', 'xls', 'docx', 'pdf'] as const;
export const UPLOAD_EXTS = ['xlsx', 'xls', 'docx', 'pdf', 'txt', 'csv'] as const;

export const MIME: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
};

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/** Validates a multipart `file` field: present, allowed extension, ≤ 50 MB. */
export function checkUploadFile(file: FormDataEntryValue | null, allowed: readonly string[]): File {
  if (!file || typeof file === 'string') throw badRequest('file_required');
  const ext = extOf(file.name);
  if (!allowed.includes(ext)) throw badRequest('unsupported_type', { allowed });
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'file_too_large', { max_bytes: MAX_UPLOAD_BYTES });
  if (file.size === 0) throw badRequest('empty_file');
  return file;
}

/** Writes bytes under DATA_DIR/<rel>, returning the absolute path and sha256. */
export async function saveFile(rel: string, file: File): Promise<{ absPath: string; sha256: string; size: number }> {
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'file_too_large', { max_bytes: MAX_UPLOAD_BYTES });
  const absPath = path.join(env.dataDir(), rel);
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, buf);
  return { absPath, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
}

/**
 * Resolves a stored path (absolute, or relative to DATA_DIR) and refuses anything outside DATA_DIR.
 */
export function resolveStored(stored: string): string {
  const root = path.resolve(env.dataDir());
  const abs = path.isAbsolute(stored) ? path.resolve(stored) : path.resolve(root, stored);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw notFound();
  return abs;
}

export async function removeDir(rel: string): Promise<void> {
  const abs = resolveStored(rel);
  await rm(abs, { recursive: true, force: true });
}

export async function streamFile(
  stored: string,
  filename: string,
  disposition: 'attachment' | 'inline',
  contentType?: string,
): Promise<Response> {
  const abs = resolveStored(stored);
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new HttpError(404, 'file_missing');
  }
  if (!st.isFile()) throw new HttpError(404, 'file_missing');
  const body = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream;
  return new Response(body, {
    headers: {
      'Content-Type': contentType || MIME[extOf(abs)] || 'application/octet-stream',
      'Content-Length': String(st.size),
      'Content-Disposition': contentDisposition(disposition, filename),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
