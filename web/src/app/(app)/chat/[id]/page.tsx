import { ChatView } from '@/components/chat/ChatView';

/** Conversation (design/chat.dc.html). */
export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChatView key={id} conversationId={id} />;
}
