'use client';

import { useEffect, useState } from 'react';
import { DesignPending } from '@/components/DesignPending';
import { UploadKnowledge } from '@/components/knowledge/UploadKnowledge';
import { FileList, useFiles } from '@/components/knowledge/FileList';
import { api } from '@/lib/client';

export default function KnowledgePage() {
  const { files, error, reload } = useFiles();
  const [status, setStatus] = useState<{ chatUnlocked: boolean; counts: { byStatus: Record<string, number>; byTag: Record<string, number> } } | null>(null);
  useEffect(() => {
    api('/api/knowledge/status').then(setStatus).catch(() => {});
  }, [files]);
  return (
    <section>
      <DesignPending />
      <h1>Knowledge</h1>
      {status && (
        <p>
          Chat {status.chatUnlocked ? 'unlocked' : 'locked'} · by status: {JSON.stringify(status.counts.byStatus)} · by type:{' '}
          {JSON.stringify(status.counts.byTag)}
        </p>
      )}
      <UploadKnowledge defaultTag="other" onUploaded={reload} />
      {error && <p role="alert">{error}</p>}
      {files ? <FileList files={files} onChanged={reload} /> : <p>Loading…</p>}
    </section>
  );
}
