import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/db';
import { badRequest, isUuid, json, route } from '@/lib/http';
import { requireUser } from '@/lib/auth/guard';
import { ownedConversation } from '@/lib/access';
import { MIME, UPLOAD_EXTS, checkUploadFile, extOf, saveFile } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Chat attachments (blanks, work lists). Not part of the knowledge base. */
export const POST = route(async (req) => {
  const { user } = await requireUser(req);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest('multipart_required');
  }
  const file = checkUploadFile(form.get('file'), UPLOAD_EXTS);
  const convId = form.get('conversation_id');
  let conversationId: string | null = null;
  if (typeof convId === 'string' && convId) {
    if (!isUuid(convId)) throw badRequest('invalid_conversation');
    await ownedConversation(user.id, convId);
    conversationId = convId;
  }
  const id = randomUUID();
  const ext = extOf(file.name);
  const saved = await saveFile(`uploads/${id}/original.${ext}`, file);
  const row = (await sql`
    INSERT INTO uploads (id, user_id, conversation_id, original_name, ext, mime, size_bytes, stored_path)
    VALUES (${id}, ${user.id}, ${conversationId}, ${file.name.slice(0, 500)}, ${ext}, ${MIME[ext] || file.type || null},
            ${saved.size}, ${saved.absPath})
    RETURNING id, user_id, conversation_id, original_name, ext, mime, size_bytes, created_at`)[0];
  return json({ upload: row }, 201);
});
