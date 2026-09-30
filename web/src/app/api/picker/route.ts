import { json, route } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { pickerGroups } from '@/lib/knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** "/" picker: analysed files grouped by tag. */
export const GET = route(async (req) => {
  await requireUser(req);
  return json(await pickerGroups());
});
