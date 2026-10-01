'use client';

/**
 * pdf.js loader. The library is imported lazily (browser only) and its worker is bundled by webpack via
 * `new Worker(new URL(…, import.meta.url))`, which emits the worker into /_next/static — this works with
 * `next dev` and with the standalone production build (no CDN, no copy step).
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

export type PdfDoc = PDFDocumentProxy;
export type PdfPage = PDFPageProxy;

let loading: Promise<typeof import('pdfjs-dist')> | null = null;

export function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!loading) {
    loading = import('pdfjs-dist').then((pdfjs) => {
      if (!pdfjs.GlobalWorkerOptions.workerPort) {
        pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' });
      }
      return pdfjs;
    }).catch((e) => { loading = null; throw e; });
  }
  return loading;
}
