import { getDocument, PDFWorker } from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';

/** PDF.js 与 Worker 仅在打开预览后加载；内联 Blob Worker 同时支持开发服务器和 Electron file://。 */
export function LoadResumePdf(base64: string) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const port = new PdfWorker();
  const worker = PDFWorker.create({ port });
  const task = getDocument({ data: bytes, worker, isEvalSupported: false, useSystemFonts: false });
  return { task, async Destroy() { try { await task.destroy(); } finally { worker.destroy(); port.terminate(); } } };
}
