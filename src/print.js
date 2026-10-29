// Printing: builds the PDF with every edit, renders each page to an image
// and hands a print-only view to the system print dialog.
import { pdfjsLib } from './pdf.js';
import { buildPdf } from './export.js';

const PRINT_DPI = 200;

function assetDir(dir) { return new URL(`pdfjs/${dir}/`, document.baseURI).href; }

/**
 * @param {(text: string) => void} progress
 * @param {(jobName: string) => Promise<{success: boolean, reason?: string}>} showDialog
 */
export async function printDocument(jobName, progress, showDialog) {
  const { bytes } = await buildPdf();
  const task = pdfjsLib.getDocument({
    data: bytes,
    cMapUrl: assetDir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetDir('standard_fonts'),
    wasmUrl: assetDir('wasm'),
    iccUrl: assetDir('iccs'),
  });
  const pdf = await task.promise;

  const root = document.createElement('div');
  root.id = 'print-root';
  const urls = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      progress(`Preparing page ${i} of ${pdf.numPages}…`);
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      // keep huge pages from blowing up memory
      const scale = Math.min(PRINT_DPI / 72, 5000 / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE, intent: 'print' }).promise;
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      canvas.width = canvas.height = 0;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const sheet = document.createElement('div');
      sheet.className = 'print-page';
      const img = new Image();
      img.src = url;
      sheet.append(img);
      root.append(sheet);
      page.cleanup();
    }
    document.body.append(root);
    await Promise.all([...root.querySelectorAll('img')].map((im) => im.decode().catch(() => {})));
    document.body.classList.add('printing');
    progress('');
    return await showDialog(jobName);
  } finally {
    document.body.classList.remove('printing');
    root.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
    // cleanup must never turn a finished print into an error
    task.destroy().catch(() => {});
  }
}
