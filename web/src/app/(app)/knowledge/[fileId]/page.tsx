import { DesignPending } from '@/components/DesignPending';
import { FileDetail } from './FileDetail';

export default async function KnowledgeFilePage({ params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  return (
    <section>
      <DesignPending />
      <FileDetail fileId={fileId} />
    </section>
  );
}
