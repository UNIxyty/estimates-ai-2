import { Suspense } from 'react';
import { NewChat } from '@/components/chat/NewChat';

export const dynamic = 'force-dynamic';

/**
 * New chat (design/chat-new.dc.html). Locked until a reference estimate is analysed (GET /api/knowledge/status).
 * `?file=<knowledge file id>` (from "Ask about this document") starts with that file as a reference chip.
 */
export default function NewChatPage() {
  return (
    <Suspense>
      <NewChat />
    </Suspense>
  );
}
