import { Suspense } from 'react';
import { FileDetail } from '@/components/knowledge/detail/FileDetail';

export const metadata = { title: 'File · Knowledge base' };

export default async function KnowledgeFilePage({ params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  return (
    <Suspense>
      <FileDetail fileId={fileId} />
    </Suspense>
  );
}
