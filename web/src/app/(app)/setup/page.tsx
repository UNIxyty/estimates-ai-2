'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { DesignPending } from '@/components/DesignPending';
import { UploadKnowledge } from '@/components/knowledge/UploadKnowledge';
import { FileList, useFiles } from '@/components/knowledge/FileList';
import { api } from '@/lib/client';

/** First run: upload at least one reference estimate; chat unlocks once one is analysed. */
export default function SetupPage() {
  const { files, error, reload } = useFiles();
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  useEffect(() => {
    api<{ chatUnlocked: boolean }>('/api/knowledge/status').then((s) => setUnlocked(s.chatUnlocked)).catch(() => {});
  }, [files]);

  return (
    <section>
      <DesignPending />
      <h1>Set up your knowledge</h1>
      <ol>
        <li>Upload at least one past <b>reference estimate</b> (required — chat unlocks when one is analysed).</li>
        <li>Optionally add hourly norms and supplier price lists.</li>
        <li>Wait for analysis to finish, then start chatting.</li>
      </ol>
      <UploadKnowledge onUploaded={reload} />
      <h2>Files</h2>
      {error && <p role="alert">{error}</p>}
      {files ? <FileList files={files} onChanged={reload} /> : <p>Loading…</p>}
      <p>
        {unlocked ? (
          <Link href="/chat">Chat is ready — start a new estimate →</Link>
        ) : (
          <span>Chat is locked until a reference estimate has been analysed.</span>
        )}
      </p>
    </section>
  );
}
