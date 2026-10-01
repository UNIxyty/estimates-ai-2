'use client';

import { api, ApiError } from '@/lib/client';
import type { ComposerChip } from './Composer';
import type { ChatMessage } from './types';

/**
 * POST /api/conversations/{id}/messages from composer chips: uploads → attachment_ids, knowledge files →
 * reference_ids. Documents opened in the viewer ("Ask about this document") are context only: follow-up
 * questions always read the conversation's latest estimate. A message with only an attachment gets a short
 * default text (the API requires text).
 */
export async function postChatMessage(conversationId: string, text: string, chips: ComposerChip[]) {
  const attachments = chips.filter((c) => c.source === 'upload' && c.id).map((c) => c.id!);
  const refs = chips.filter((c) => c.source === 'file' && c.id).map((c) => c.id!);
  const hasBlank = chips.some((c) => c.source === 'upload' && /\.xlsx?$/i.test(c.name));
  const body = text || (hasBlank ? 'Fill in this blank.' : 'Build an estimate from this work list.');
  return api<{ message: ChatMessage; run: { id: string; status: string; created_at?: string } }>(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    json: { text: body, attachment_ids: attachments, reference_ids: refs },
  });
}

export function sendErrorText(err: unknown): string {
  const b = err instanceof ApiError ? err.body : {};
  if (b.error === 'budget_paused') return 'The monthly budget is used up; chat is paused.';
  if (b.error === 'chat_locked') return 'Chat opens after your first reference is analysed.';
  if (b.error === 'run_active') return 'Wait for the current answer to finish, or stop it.';
  if (b.error === 'invalid_reference') return 'A selected reference is not analysed yet.';
  if (b.error === 'invalid_attachment') return 'An attachment could not be used. Attach it again.';
  return (err as Error)?.message || 'Could not send.';
}
