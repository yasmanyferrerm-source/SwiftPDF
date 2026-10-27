// pdf.js setup + page helpers
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { state, uid } from './state.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
export { pdfjsLib };

const assetDir = (dir) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

/**
 * Loads a PDF into state.docs and returns page entries for it.
 * The bytes are kept (pdf.js gets its own copy) so we can re-save later.
 */
export async function loadPdf(bytes, name) {
  let needsPassword = false;
  const task = pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: assetDir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetDir('standard_fonts'),
    wasmUrl: assetDir('wasm'),
    iccUrl: assetDir('iccs'),
    enableXfa: false,
  });
  task.onPassword = (updatePassword, reason) => {
    needsPassword = true;
    const msg = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
      ? 'Incorrect password. Try again:'
      : `"${name}" is password-protected. Enter the password:`;
    const pw = window.prompt(msg);
    if (pw === null) task.destroy();
    else updatePassword(pw);
  };
  const pdf = await task.promise;
  const id = uid('d');
  state.docs.set(id, { id, name, bytes, pdf, needsPassword });
  const entries = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    entries.push({ id: uid('p'), docId: id, srcIndex: i, rot: 0, baseRot: page.rotate || 0, view: page.view.slice() });
  }
  return entries;
}

export function blankPageEntry(width = 612, height = 792) {
  return { id: uid('p'), docId: null, srcIndex: -1, rot: 0, baseRot: 0, view: [0, 0, width, height] };
}

export const viewRotation = (entry) => (((entry.baseRot + entry.rot) % 360) + 360) % 360;

export function getPdfPage(entry) {
  if (!entry.docId) return Promise.resolve(null);
  return state.docs.get(entry.docId).pdf.getPage(entry.srcIndex + 1);
}

/** Viewport for blank pages (same math as pdf.js PageViewport). */
export class SimpleViewport {
  constructor(viewBox, scale, rotation) {
    const [x1, y1, x2, y2] = viewBox;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    let a, b, c, d;
    switch (rotation) {
      case 90: a = 0; b = 1; c = 1; d = 0; break;
      case 180: a = -1; b = 0; c = 0; d = 1; break;
      case 270: a = 0; b = -1; c = -1; d = 0; break;
      default: a = 1; b = 0; c = 0; d = -1;
    }
    let ox, oy, w, h;
    if (a === 0) {
      ox = Math.abs(cy - y1) * scale; oy = Math.abs(cx - x1) * scale;
      w = (y2 - y1) * scale; h = (x2 - x1) * scale;
    } else {
      ox = Math.abs(cx - x1) * scale; oy = Math.abs(cy - y1) * scale;
      w = (x2 - x1) * scale; h = (y2 - y1) * scale;
    }
    this.transform = [a * scale, b * scale, c * scale, d * scale, ox - a * scale * cx - c * scale * cy, oy - b * scale * cx - d * scale * cy];
    this.width = w;
    this.height = h;
    this.scale = scale;
    this.rotation = rotation;
  }
  convertToViewportPoint(x, y) {
    const t = this.transform;
    return [x * t[0] + y * t[2] + t[4], x * t[1] + y * t[3] + t[5]];
  }
  convertToPdfPoint(x, y) {
    const t = this.transform;
    const det = t[0] * t[3] - t[1] * t[2];
    return [((x - t[4]) * t[3] - (y - t[5]) * t[2]) / det, (-(x - t[4]) * t[1] + (y - t[5]) * t[0]) / det];
  }
}

export async function getViewport(entry, scale) {
  const rotation = viewRotation(entry);
  const page = await getPdfPage(entry);
  if (page) return page.getViewport({ scale, rotation });
  return new SimpleViewport(entry.view, scale, rotation);
}

/** Synchronous viewport (uses the same math) - good for layout before pages load. */
export function viewportSync(entry, scale) {
  return new SimpleViewport(entry.view, scale, viewRotation(entry));
}

const MAX_CANVAS_PIXELS = 12_000_000;

/** Renders a page into a canvas at CSS size of `vp`. Returns the render task. */
export async function renderPageToCanvas(entry, canvas, vp, { dprCap = 2 } = {}) {
  let dpr = Math.min(window.devicePixelRatio || 1, dprCap);
  while (vp.width * vp.height * dpr * dpr > MAX_CANVAS_PIXELS && dpr > 0.5) dpr -= 0.25;
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = `${vp.width}px`;
  canvas.style.height = `${vp.height}px`;
  const ctx = canvas.getContext('2d');
  const page = await getPdfPage(entry);
  if (!page) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return null;
  }
  const task = page.render({
    canvasContext: ctx,
    viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
  });
  return task;
}

const textCache = new Map();
export async function getTextContent(entry) {
  if (!entry.docId) return { items: [], styles: {} };
  const key = `${entry.docId}:${entry.srcIndex}`;
  if (!textCache.has(key)) {
    textCache.set(key, getPdfPage(entry).then((p) => p.getTextContent()));
  }
  return textCache.get(key);
}

const annotCache = new Map();
export async function getWidgets(entry) {
  if (!entry.docId) return [];
  const key = `${entry.docId}:${entry.srcIndex}`;
  if (!annotCache.has(key)) {
    annotCache.set(key, getPdfPage(entry)
      .then((p) => p.getAnnotations({ intent: 'display' }))
      .then((list) => list.filter((a) => a.subtype === 'Widget' && a.fieldName && !a.pushButton && !a.hidden))
      .catch(() => []));
  }
  return annotCache.get(key);
}
