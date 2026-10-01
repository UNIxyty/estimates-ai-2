'use client';

import { createContext, useContext } from 'react';
import type { Card, Doc, FileRef, LiveRun } from './types';

/** What messages and cards need from the conversation page (opening the viewer, card decisions). */
export interface ChatCtx {
  docs: Record<string, Doc>;
  runs: Record<string, LiveRun>;
  /** Knowledge files by id (for chip names / languages). */
  files: Record<string, FileRef>;
  openDocument: (docId: string, jump?: { sheet?: string | null; row?: number | null }, fallbackName?: string) => void;
  openFile: (fileId: string, name?: string, jump?: { sheet?: string | null; row?: number | null }) => void;
  openUpload: (uploadId: string, name: string) => void;
  onCard: (c: Card) => void;
  /** A decision may resume the card's run: keep its event stream open. */
  followRun: (runId: string) => void;
  stopRun: (runId: string) => void;
}

export const ChatContext = createContext<ChatCtx>({
  docs: {},
  runs: {},
  files: {},
  openDocument: () => {},
  openFile: () => {},
  openUpload: () => {},
  onCard: () => {},
  followRun: () => {},
  stopRun: () => {},
});
export const useChat = () => useContext(ChatContext);
