import { route, uuidParam, HttpError } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { visibleFile } from '@/lib/access';
import { streamFile } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Original bytes inline (pdf.js viewer). */
export const GET = route<{ id: string }>(async (req, p) => {
  await requireUser(req);
  const f = await visibleFile(uuidParam(p.id));
  if (f.ext !== 'pdf') throw new HttpError(400, 'not_pdf');
  return streamFile(f.stored_path, f.original_name, 'inline', 'application/pdf');
});
