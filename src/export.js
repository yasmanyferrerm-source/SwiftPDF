// Builds the output PDF with pdf-lib: form values, page organization and
// every annotation/signature/text edit are written into the real PDF.
import {
  PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle,
  PDFTextField, PDFCheckBox, PDFArray, PDFName, PDFRef, PDFRadioGroup, PDFDropdown, PDFOptionList,
} from 'pdf-lib';
import { state } from './state.js';
import { LINE_H, BASELINE, textLines } from './overlay.js';
import { getPdfPage, pdfjsLib } from './pdf.js';

const FONT_MAP = { Helvetica: StandardFonts.Helvetica, Times: StandardFonts.TimesRoman, Courier: StandardFonts.Courier };

function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function dataUrlBytes(url) {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function applyForms(doc, values) {
  if (!values || !Object.keys(values).length) return false;
  let form;
  try { form = doc.getForm(); } catch { return false; }
  for (const [name, val] of Object.entries(values)) {
    try {
      const f = form.getFieldMaybe(name);
      if (!f) continue;
      if (f instanceof PDFTextField) f.setText(val == null ? '' : String(val));
      else if (f instanceof PDFCheckBox) (val ? f.check() : f.uncheck());
      else if (f instanceof PDFRadioGroup) { if (val && f.getOptions().includes(val)) f.select(val); }
      else if (f instanceof PDFDropdown || f instanceof PDFOptionList) { if (val) f.select(val); else f.clear(); }
    } catch (err) {
      console.warn('form field', name, err);
    }
  }
  return true;
}

/** Characters the standard fonts can't encode become '?' instead of crashing the save. */
function safeText(font, text) {
  let out = '';
  for (const ch of text) {
    try { font.encodeText(ch); out += ch; } catch { out += ch === '\t' ? '    ' : '?'; }
  }
  return out;
}

function isEncrypted(doc) {
  try { return doc.isEncrypted; } catch { return false; }
}

/**
 * @param {object} opts
 * @param {Set<string>} [opts.onlyPages] page ids to include (for "extract pages")
 * @returns {Promise<{bytes: Uint8Array, notes: string[]}>}
 */
export async function buildPdf({ onlyPages = null } = {}) {
  const notes = [];
  const entries = state.pages.filter((p) => !onlyPages || onlyPages.has(p.id));
  if (!entries.length) throw new Error('There are no pages to save.');

  // Load each source document that is still used.
  const usedDocs = new Set(entries.map((e) => e.docId).filter(Boolean));
  const libDocs = new Map();
  for (const id of usedDocs) {
    const d = state.docs.get(id);
    const doc = await PDFDocument.load(d.bytes, { ignoreEncryption: true, updateMetadata: false });
    const encrypted = d.needsPassword || isEncrypted(doc);
    if (!encrypted) {
      const hadForms = applyForms(doc, state.forms[id]);
      if (hadForms) {
        try {
          const font = await doc.embedFont(StandardFonts.Helvetica);
          doc.getForm().updateFieldAppearances(font);
        } catch (err) { console.warn('appearances', err); }
      }
    }
    libDocs.set(id, { doc, encrypted });
  }

  // Can we write straight into the original file (keeps forms, links, bookmarks)?
  const docIds = [...usedDocs];
  let out;
  let outPages;
  const single = docIds.length === 1 && !entries.some((e) => !e.docId) ? libDocs.get(docIds[0]) : null;
  const identity = single && !single.encrypted && !onlyPages
    && entries.length === single.doc.getPageCount()
    && entries.every((e, i) => e.srcIndex === i);

  if (identity) {
    out = single.doc;
    outPages = out.getPages();
  } else {
    out = await PDFDocument.create();
    // Forms can't be carried across documents reliably, so bake them into the pages.
    for (const [id, { doc, encrypted }] of libDocs) {
      if (encrypted) continue;
      try {
        const form = doc.getForm();
        if (form.getFields().length) { form.flatten(); if (!notes.includes('forms')) notes.push('forms'); }
      } catch { /* no form */ }
    }
    const copied = new Map();
    for (const [id, { doc, encrypted }] of libDocs) {
      if (encrypted) continue;
      const idx = [...new Set(entries.filter((e) => e.docId === id).map((e) => e.srcIndex))];
      const pages = await out.copyPages(doc, idx);
      idx.forEach((srcIndex, k) => copied.set(`${id}:${srcIndex}`, pages[k]));
    }
    outPages = [];
    for (const e of entries) {
      let page;
      if (!e.docId) {
        const [x1, y1, x2, y2] = e.view;
        page = out.addPage([x2 - x1, y2 - y1]);
      } else if (libDocs.get(e.docId).encrypted) {
        page = await rasterPage(out, e);
        if (!notes.includes('encrypted')) notes.push('encrypted');
      } else {
        const key = `${e.docId}:${e.srcIndex}`;
        const src = copied.get(key);
        // the same source page used twice needs a second copy
        page = out.addPage(src.__used ? (await out.copyPages(libDocs.get(e.docId).doc, [e.srcIndex]))[0] : src);
        src.__used = true;
      }
      outPages.push(page);
    }
  }

  if (!identity) {
    // drop annotation references left dangling by form flattening
    for (const page of outPages) {
      const annots = page.node.lookup(PDFName.of('Annots'));
      if (!(annots instanceof PDFArray)) continue;
      const keep = annots.asArray().filter((ref) => !(ref instanceof PDFRef) || out.context.lookup(ref));
      if (keep.length === annots.size()) continue;
      if (keep.length) page.node.set(PDFName.of('Annots'), out.context.obj(keep));
      else page.node.delete(PDFName.of('Annots'));
    }
  }

  const fonts = {};
  const getFont = async (name) => (fonts[name] ||= await out.embedFont(FONT_MAP[name] || StandardFonts.Helvetica));
  const images = new Map();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const page = outPages[i];
    page.setRotation(degrees((((e.baseRot + e.rot) % 360) + 360) % 360));
    const items = state.items.filter((it) => it.pageId === e.id);
    // covers + whiteout first so new content lands on top
    for (const it of items) {
      const r = it.type === 'whiteout' ? it : it.type === 'text' ? it.cover : null;
      if (!r) continue;
      page.drawRectangle({
        x: Math.min(r.x1, r.x2), y: Math.min(r.y1, r.y2),
        width: Math.abs(r.x2 - r.x1), height: Math.abs(r.y2 - r.y1), color: rgb(1, 1, 1),
      });
    }
    for (const it of items) {
      const color = hexToRgb(it.color);
      const thickness = it.size || 2;
      switch (it.type) {
        case 'ink': {
          const pts = it.points;
          for (let k = 1; k < pts.length; k++) {
            page.drawLine({ start: { x: pts[k - 1][0], y: pts[k - 1][1] }, end: { x: pts[k][0], y: pts[k][1] }, thickness, color, lineCap: LineCapStyle.Round });
          }
          break;
        }
        case 'line':
          page.drawLine({ start: { x: it.x1, y: it.y1 }, end: { x: it.x2, y: it.y2 }, thickness, color, lineCap: LineCapStyle.Round });
          break;
        case 'highlight':
        case 'rect': {
          const box = { x: Math.min(it.x1, it.x2), y: Math.min(it.y1, it.y2), width: Math.abs(it.x2 - it.x1), height: Math.abs(it.y2 - it.y1) };
          if (it.type === 'highlight') page.drawRectangle({ ...box, color, opacity: 0.4, blendMode: BlendMode.Multiply });
          else page.drawRectangle({ ...box, borderColor: color, borderWidth: thickness });
          break;
        }
        case 'ellipse':
          page.drawEllipse({
            x: (it.x1 + it.x2) / 2, y: (it.y1 + it.y2) / 2,
            xScale: Math.abs(it.x2 - it.x1) / 2, yScale: Math.abs(it.y2 - it.y1) / 2,
            borderColor: color, borderWidth: thickness,
          });
          break;
        case 'text': {
          const font = await getFont(it.font);
          const lines = textLines(it);
          const fs = it.fontSize;
          const r = ((it.rot || 0) * Math.PI) / 180;
          const top = lines.length * LINE_H * fs;
          lines.forEach((line, n) => {
            if (!line) return;
            const ly = top - BASELINE * fs - n * LINE_H * fs;
            page.drawText(safeText(font, line), {
              x: it.ax - ly * Math.sin(r),
              y: it.ay + ly * Math.cos(r),
              size: fs, font, color, rotate: degrees(it.rot || 0),
            });
          });
          break;
        }
        case 'image': {
          let img = images.get(it.src);
          if (!img) {
            const bytes = dataUrlBytes(it.src);
            img = it.src.startsWith('data:image/jpeg') || it.src.startsWith('data:image/jpg') ? await out.embedJpg(bytes) : await out.embedPng(bytes);
            images.set(it.src, img);
          }
          page.drawImage(img, { x: it.ax, y: it.ay, width: it.w, height: it.h, rotate: degrees(it.rot || 0) });
          break;
        }
        default:
      }
    }
  }

  out.setProducer('SwiftPDF');
  const bytes = await out.save({ useObjectStreams: false });
  return { bytes, notes };
}

/** Fallback for encrypted files pdf-lib can't rewrite: page becomes a high-res image. */
async function rasterPage(out, entry) {
  const pdfPage = await getPdfPage(entry);
  const vp = pdfPage.getViewport({ scale: 2.5, rotation: 0 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
  const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  const [x1, y1, x2, y2] = entry.view;
  const page = out.addPage([x2 - x1, y2 - y1]);
  page.setMediaBox(x1, y1, x2 - x1, y2 - y1);
  page.drawImage(img, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
  return page;
}
