import Link from 'next/link';
import { Suspense } from 'react';
import { DesignPending } from '@/components/DesignPending';
import { ChatView } from '@/components/chat/ChatView';
import { chatUnlocked } from '@/lib/chat';

export const dynamic = 'force-dynamic';

/** New chat. Locked until at least one reference estimate is analysed (chat_unlocked()). */
export default async function NewChatPage() {
  const unlocked = await chatUnlocked();
  return (
    <section>
      <DesignPending />
      {unlocked ? (
        <Suspense>
          <ChatView conversationId={null} />
        </Suspense>
      ) : (
        <>
          <h1>Chat is locked</h1>
          <p>The agent needs at least one analysed reference estimate before it can price anything.</p>
          <p><Link href="/setup">Upload a reference estimate →</Link></p>
        </>
      )}
    </section>
  );
}
