import { Suspense } from 'react';
import { DesignPending } from '@/components/DesignPending';
import { ChatView } from '@/components/chat/ChatView';

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <section>
      <DesignPending />
      <Suspense>
        <ChatView key={id} conversationId={id} />
      </Suspense>
    </section>
  );
}
