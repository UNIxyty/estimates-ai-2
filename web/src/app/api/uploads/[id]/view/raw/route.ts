import { route, uuidParam, HttpError } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { streamFile } from '@/lib/storage';
import { ownedUpload } from '../../owned';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Original PDF bytes inline for the pdf.js viewer (owner only). */
export const GET = route<{ id: string }>(async (req, p) => {
  const { user } = await requireUser(req);
  const u = await ownedUpload(user.id, uuidParam(p.id));
  if (u.ext !== 'pdf') throw new HttpError(400, 'not_pdf');
  return streamFile(u.stored_path, u.original_name, 'inline', 'application/pdf');
});
