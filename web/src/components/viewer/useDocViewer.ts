'use client';

import { useCallback, useMemo, useState } from 'react';
import { docKey, type DocRef, type Jump, type ViewerMode } from './types';

export interface DocViewerState {
  docs: DocRef[];
  activeKey: string | null;
  jump: Jump | null;
  /** Bumped on every open() so a repeated jump to the same row re-triggers scrolling. */
  jumpSeq: number;
  mode: Exclude<ViewerMode, 'sheet'>;
  isOpen: boolean;
  open: (doc: DocRef, jump?: Jump) => void;
  closeTab: (key: string) => void;
  select: (key: string) => void;
  close: () => void;
  setMode: (m: 'split' | 'full') => void;
}

/** Tabs of open documents; one active. Closing the last tab closes the viewer. */
export function useDocViewer(): DocViewerState {
  const [docs, setDocs] = useState<DocRef[]>([]);
  const [activeKey, setActive] = useState<string | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const [jumpSeq, setSeq] = useState(0);
  const [mode, setMode] = useState<'split' | 'full'>('split');

  const open = useCallback((doc: DocRef, j?: Jump) => {
    const k = docKey(doc);
    setDocs((ds) => (ds.some((d) => docKey(d) === k) ? ds.map((d) => (docKey(d) === k ? { ...d, ...doc } : d)) : [...ds, doc]));
    setActive(k);
    setJump(j ?? null);
    setSeq((s) => s + 1);
  }, []);
  const closeTab = useCallback((k: string) => {
    setDocs((ds) => {
      const rest = ds.filter((d) => docKey(d) !== k);
      setActive((a) => (a === k ? (rest.length ? docKey(rest[rest.length - 1]) : null) : a));
      return rest;
    });
  }, []);
  const close = useCallback(() => { setDocs([]); setActive(null); setJump(null); setMode('split'); }, []);
  const select = useCallback((k: string) => { setActive(k); setJump(null); }, []);

  return useMemo(() => ({ docs, activeKey, jump, jumpSeq, mode, isOpen: docs.length > 0 && activeKey != null, open, closeTab, select, close, setMode }),
    [docs, activeKey, jump, jumpSeq, mode, open, closeTab, select, close]);
}
