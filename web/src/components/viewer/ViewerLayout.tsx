'use client';

/**
 * CONTRACT (implemented by the DocViewer work): wraps a page's content and shows the viewer beside it.
 *  - split (default): content | draggable divider (viewer 26–70% of the width) | <DocViewer mode="split">;
 *    collapses the app sidebar while open (useShell().setCollapsedOverride).
 *  - full: content collapses to a 64px rail with "‹ Chat" (back to split) and "Ask" (floating composer via
 *    renderAsk, if given); the viewer fills the rest.
 *  - phone (<760px): the viewer is a full-screen sheet with a "‹ Back" bar.
 * `onAsk(doc)` is called by "Ask about this document" (chat focuses the composer and adds the file as a chip).
 */
import type { ReactNode } from 'react';
import type { DocViewerState } from './useDocViewer';
import type { DocRef } from './types';

export interface ViewerLayoutProps {
  viewer: DocViewerState;
  children: ReactNode;
  onAsk?: (doc: DocRef) => void;
  /** Floating composer shown by the rail's "Ask" button in full-screen mode (chat only). */
  renderAsk?: () => ReactNode;
  /** Label of the rail's back button, e.g. "Chat" or "Library". */
  railLabel?: string;
}

export { ViewerLayout } from './ViewerLayoutImpl';
