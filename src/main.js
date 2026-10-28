import { state, on, emit, beginChange, undo, redo, canUndo, canRedo, resetHistory, setDirty, getItem } from './state.js';
import { loadPdf, getTextContent } from './pdf.js';
import { buildPages, setZoom, fitWidthZoom, setTool, scrollToPage, getCurrentPageIndex, highlightSearch, clearSearchHighlights, pageViews } from './viewer.js';
import { buildThumbs, rotatePages, deletePages, movePages, insertPages, insertBlankPage, selectAllPages, syncPicks } from './organize.js';
import { deleteItem } from './overlay.js';
import { buildPdf } from './export.js';
import { openSignatureDialog, isSignatureOpen, closeSignature } from './signature.js';
import * as platform from './platform.js';
import { printDocument } from './print.js';

const $ = (id) => document.getElementById(id);
const body = document.body;

// ------------------------------------------------------------- helpers --
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function busy(on, text = 'Working…') {
  $('busy').hidden = !on;
  $('busy-text').textContent = text;
}
function updateTitle() {
  const name = state.fileName || 'SwiftPDF';
  platform.setWindowTitle(state.fileName ? `${state.dirty ? '• ' : ''}${name} — SwiftPDF` : 'SwiftPDF');
}

body.classList.add(`plat-${platform.platformName}`);
if (platform.canShare) $('btn-share').hidden = false;
if (platform.isAndroid) $('btn-saveas').hidden = true;
if (!platform.canPrint) $('btn-print').hidden = true;
if (!platform.canMultiWindow) $('btn-newwin').hidden = true;

// --------------------------------------------------------- open / save --
async function openDocument(file) {
  if (!file) return;
  if (state.dirty && !confirm('Discard unsaved changes and open another file?')) return;
  busy(true, 'Opening…');
  try {
    for (const d of state.docs.values()) d.pdf.destroy?.();
    state.docs.clear();
    const entries = await loadPdf(file.data, file.name);
    state.pages = entries;
    state.items = [];
    state.forms = {};
    state.selectedId = null;
    state.editingId = null;
    state.selectedPages = new Set();
    state.fileName = file.name;
    state.filePath = file.path || null;
    resetHistory();
    setDirty(false);
    body.classList.remove('no-doc');
    setTool('select');
    state.zoom = fitWidthZoom();
    state.fitMode = 'width';
    buildPages({ keepScroll: false });
    buildThumbs();
    $('viewer').scrollTop = 0;
    emit('zoom', state.zoom);
    updateTitle();
    platform.setHasDoc(true);
  } catch (err) {
    console.error(err);
    if (!state.pages.length) platform.setHasDoc(false);
    toast(err?.name === 'PasswordException' ? 'Could not open: password required.' : `Could not open this file: ${err.message || err}`, 5000);
  } finally {
    busy(false);
  }
}

/** Desktop: a window already showing a PDF opens new files in new windows. */
const opensInNewWindow = () => platform.canMultiWindow && state.pages.length > 0;

async function doOpen() {
  try {
    const loaders = await platform.pickPdfFiles();
    if (!loaders.length) return;
    let rest = loaders;
    if (!opensInNewWindow()) {
      await openDocument(await loaders[0]());
      rest = loaders.slice(1);
    }
    for (const load of rest) await platform.openInNewWindow({ path: load.path });
  } catch (err) {
    toast(`Open failed: ${err.message || err}`);
  }
}

async function doPrint() {
  if (!state.pages.length || !platform.canPrint) return;
  commitEditing();
  busy(true, 'Preparing to print…');
  try {
    const res = await printDocument(state.fileName || 'SwiftPDF', (t) => { if (t) $('busy-text').textContent = t; else busy(false); }, platform.printView);
    if (res && !res.success && res.reason && !/cancel/i.test(res.reason)) toast(`Printing failed: ${res.reason}`, 5000);
  } catch (err) {
    console.error(err);
    toast(`Printing failed: ${err.message || err}`, 5000);
  } finally {
    busy(false);
  }
}

function commitEditing() {
  if (state.editingId) document.activeElement?.blur?.();
  if (document.activeElement?.classList?.contains('form-field')) document.activeElement.blur();
}

const NOTE_TEXT = {
  forms: 'Form fields were filled in and flattened because pages were reorganized.',
  encrypted: 'This PDF is protected, so its pages were saved as images.',
};

async function doSave({ saveAs = false } = {}) {
  if (!state.pages.length) return;
  commitEditing();
  busy(true, 'Saving…');
  try {
    const { bytes, notes } = await buildPdf();
    const name = state.fileName || 'document.pdf';
    const res = await platform.saveFile(bytes, { name, path: state.filePath, saveAs });
    if (!res) return;
    if (res.path) {
      state.filePath = res.path;
      state.fileName = res.path.split(/[\\/]/).pop();
    }
    setDirty(false);
    updateTitle();
    toast([`Saved to ${res.label}`, ...notes.map((n) => NOTE_TEXT[n])].join('\n'), notes.length ? 6000 : 3200);
  } catch (err) {
    console.error(err);
    toast(`Save failed: ${err.message || err}`, 6000);
  } finally {
    busy(false);
  }
}

async function doShare() {
  if (!state.pages.length) return;
  commitEditing();
  busy(true, 'Preparing…');
  try {
    const { bytes } = await buildPdf();
    busy(false);
    await platform.shareFile(bytes, state.fileName || 'document.pdf');
  } catch (err) {
    if (!/cancel/i.test(err?.message || '')) toast(`Share failed: ${err.message || err}`);
  } finally {
    busy(false);
  }
}

async function doExtract() {
  const ids = state.selectedPages.size ? new Set(state.selectedPages) : new Set([state.pages[getCurrentPageIndex()]?.id]);
  commitEditing();
  busy(true, 'Extracting pages…');
  try {
    const { bytes } = await buildPdf({ onlyPages: ids });
    const base = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    const res = await platform.saveFile(bytes, { name: `${base}-pages.pdf`, saveAs: true });
    if (res) toast(`${ids.size} page${ids.size > 1 ? 's' : ''} saved to ${res.label}`);
  } catch (err) {
    toast(`Extract failed: ${err.message || err}`);
  } finally {
    busy(false);
  }
}

async function doInsertPdf() {
  try {
    const file = await platform.openPdfFile();
    if (!file) return;
    busy(true, 'Adding pages…');
    const entries = await loadPdf(file.data, file.name);
    insertPages(entries);
    toast(`Added ${entries.length} page${entries.length > 1 ? 's' : ''} from ${file.name}`);
  } catch (err) {
    toast(`Could not add that PDF: ${err.message || err}`);
  } finally {
    busy(false);
  }
}

// ---------------------------------------------------------------- tools --
const HINTS = {
  select: 'Tap an item to select it. Drag to move. Tap selected text again to edit it.',
  text: 'Tap anywhere on the page to type.',
  edittext: 'Tap any text in the PDF to change it.',
  draw: 'Draw with your mouse, finger or pen.',
  highlight: 'Drag over the area to highlight.',
  shape: 'Drag on the page to draw the shape.',
  whiteout: 'Drag over anything you want to cover with white.',
  place: 'Tap where the signature or image should go.',
  date: "Tap where today's date should go.",
};

async function chooseTool(tool) {
  if (!state.pages.length) return;
  if (tool === 'sign') {
    const sig = await openSignatureDialog();
    if (!sig) return;
    state.pendingImage = { ...sig, kind: 'signature' };
    setTool('place');
    state.pendingImage = { ...sig, kind: 'signature' };
    return;
  }
  if (tool === 'image') {
    const img = await platform.pickImage().catch(() => null);
    if (!img) return;
    setTool('place');
    state.pendingImage = { ...img, kind: 'image' };
    return;
  }
  setTool(state.tool === tool && tool !== 'select' ? 'select' : tool);
}

on('tool', (tool) => {
  document.querySelectorAll('.tool').forEach((b) => {
    const t = b.dataset.tool;
    b.classList.toggle('active', t === tool || (tool === 'place' && t === 'sign' && state.pendingImage?.kind !== 'image'));
  });
  $('tool-hint').textContent = HINTS[tool] || '';
  syncOptionsBar();
});

function syncOptionsBar() {
  const sel = state.selectedId ? getItem(state.selectedId) : null;
  const ctx = sel?.type === 'text' && (state.tool === 'select' || state.tool === 'text') ? 'text' : state.tool;
  document.querySelectorAll('#optionsbar .opt[data-for]').forEach((o) => {
    o.hidden = !o.dataset.for.split(' ').includes(ctx);
  });
  $('sel-actions').hidden = !sel;
  $('tool-hint').hidden = !!sel;
  const anyOpt = [...document.querySelectorAll('#optionsbar .opt[data-for]')].some((o) => !o.hidden);
  $('optionsbar').classList.toggle('empty', !anyOpt && !sel);
  if (sel?.type === 'text') {
    $('opt-font').value = sel.font;
    $('opt-fontsize').value = Math.round(sel.fontSize * 10) / 10;
    markSwatch('colors', sel.color);
  } else {
    $('opt-font').value = state.opts.font;
    $('opt-fontsize').value = state.opts.fontSize;
    markSwatch('colors', state.opts.color);
  }
}
on('selection', syncOptionsBar);

function updateSelectedText(fn) {
  const sel = state.selectedId ? getItem(state.selectedId) : null;
  if (sel?.type !== 'text') return false;
  beginChange();
  fn(sel);
  emit('items', sel.pageId);
  return true;
}

const COLORS = ['#111827', '#1d4ed8', '#dc2626', '#16a34a', '#ea580c', '#7c3aed', '#ffffff'];
const HL_COLORS = ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#fb923c'];
function makeSwatches(id, colors, onPick) {
  const box = $(id);
  for (const c of colors) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.setProperty('--c', c);
    b.dataset.color = c;
    b.title = c;
    b.addEventListener('click', () => { onPick(c); markSwatch(id, c); });
    box.append(b);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.title = 'Custom color';
  custom.addEventListener('input', () => { onPick(custom.value); markSwatch(id, custom.value); });
  box.append(custom);
}
function markSwatch(id, color) {
  $(id).querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.color.toLowerCase() === (color || '').toLowerCase()));
}
makeSwatches('colors', COLORS, (c) => { if (!updateSelectedText((it) => { it.color = c; })) state.opts.color = c; });
makeSwatches('hl-colors', HL_COLORS, (c) => { state.opts.highlight = c; });
markSwatch('colors', state.opts.color);
markSwatch('hl-colors', state.opts.highlight);

$('opt-size').addEventListener('input', (e) => { state.opts.size = +e.target.value; });
$('opt-font').addEventListener('change', (e) => { if (!updateSelectedText((it) => { it.font = e.target.value; })) state.opts.font = e.target.value; });
$('opt-fontsize').addEventListener('change', (e) => {
  const v = Math.max(4, Math.min(144, +e.target.value || 14));
  if (!updateSelectedText((it) => { it.fontSize = v; })) state.opts.fontSize = v;
});
document.querySelectorAll('#shape-pick button').forEach((b) => {
  b.classList.toggle('active', b.dataset.shape === state.shape);
  b.addEventListener('click', () => {
    state.shape = b.dataset.shape;
    document.querySelectorAll('#shape-pick button').forEach((x) => x.classList.toggle('active', x === b));
  });
});
$('btn-delete-item').addEventListener('click', () => state.selectedId && deleteItem(state.selectedId));

// ----------------------------------------------------------------- zoom --
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
function stepZoom(dir) {
  const z = state.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.01) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.01);
  if (next) setZoom(next);
}
on('zoom', (z) => { $('zoom-label').textContent = `${Math.round(z * 100)}%`; });
$('btn-zoomin').addEventListener('click', () => stepZoom(1));
$('btn-zoomout').addEventListener('click', () => stepZoom(-1));
$('zoom-label').addEventListener('click', () => setZoom(fitWidthZoom(), 'width'));

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.pages.length && state.fitMode === 'width') {
      const z = fitWidthZoom();
      if (Math.abs(z - state.zoom) > 0.02) setZoom(z, 'width');
    }
  }, 200);
});

// Ctrl + wheel and pinch zoom
$('viewer').addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !state.pages.length) return;
  e.preventDefault();
  stepZoom(e.deltaY < 0 ? 1 : -1);
}, { passive: false });
let pinch = null;
$('viewer').addEventListener('touchstart', (e) => {
  if (e.touches.length === 2 && state.pages.length) {
    const [a, b] = e.touches;
    pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: state.zoom };
  }
}, { passive: true });
$('viewer').addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  const [a, b] = e.touches;
  const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const scale = d / pinch.d;
  $('pages').style.transformOrigin = 'top center';
  $('pages').style.transform = `scale(${scale})`;
  pinch.scale = scale;
}, { passive: true });
$('viewer').addEventListener('touchend', () => {
  if (!pinch) return;
  $('pages').style.transform = '';
  if (pinch.scale && Math.abs(pinch.scale - 1) > 0.05) setZoom(pinch.z * pinch.scale);
  pinch = null;
});

// --------------------------------------------------------------- events --
on('pages', () => {
  if (state.fitMode === 'width') state.zoom = fitWidthZoom();
  buildPages();
  buildThumbs();
  syncPicks();
  emit('zoom', state.zoom);
});
on('history', () => {
  $('btn-undo').disabled = !canUndo();
  $('btn-redo').disabled = !canRedo();
});
on('dirty', (d) => { platform.setDirtyFlag(d); updateTitle(); });
on('currentPage', (i) => { $('page-indicator').textContent = `${i + 1} / ${state.pages.length}`; });
on('pagePicks', (n) => { $('pick-count').textContent = n ? `· ${n} selected` : ''; });
on('closeSidebar', () => body.classList.remove('sidebar-open'));

// -------------------------------------------------------------- buttons --
$('btn-open').addEventListener('click', doOpen);
$('btn-print').addEventListener('click', doPrint);
$('btn-newwin').addEventListener('click', () => platform.newWindow());
$('btn-open-big').addEventListener('click', doOpen);
$('btn-save').addEventListener('click', () => doSave());
$('btn-saveas').addEventListener('click', () => doSave({ saveAs: true }));
$('btn-share').addEventListener('click', doShare);
$('btn-undo').addEventListener('click', () => { commitEditing(); undo(); });
$('btn-redo').addEventListener('click', () => { commitEditing(); redo(); });
document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => chooseTool(b.dataset.tool)));

const narrow = () => window.innerWidth < 760;
if (!narrow()) body.classList.add('sidebar-open');
$('btn-sidebar').addEventListener('click', () => body.classList.toggle('sidebar-open'));

$('pg-rotl').addEventListener('click', () => rotatePages(-90));
$('pg-rotr').addEventListener('click', () => rotatePages(90));
$('pg-up').addEventListener('click', () => movePages(-1));
$('pg-down').addEventListener('click', () => movePages(1));
$('pg-delete').addEventListener('click', () => {
  const n = state.selectedPages.size || 1;
  if (!confirm(`Delete ${n} page${n > 1 ? 's' : ''}?`)) return;
  if (deletePages() === 'all') toast("You can't delete every page.");
});
$('pg-extract').addEventListener('click', doExtract);
$('pg-merge').addEventListener('click', doInsertPdf);
$('pg-blank').addEventListener('click', insertBlankPage);
$('pg-all').addEventListener('click', () => selectAllPages(state.selectedPages.size !== state.pages.length));

// --------------------------------------------------------------- search --
let search = { query: '', results: [], index: -1 };
function openSearch() {
  if (!state.pages.length) return;
  $('searchbar').hidden = false;
  $('search-input').focus();
  $('search-input').select();
}
function closeSearch() {
  $('searchbar').hidden = true;
  clearSearchHighlights();
  search = { query: '', results: [], index: -1 };
  $('search-count').textContent = '';
}
async function runSearch(query) {
  const q = query.trim().toLowerCase();
  search = { query: q, results: [], index: -1 };
  if (!q) { $('search-count').textContent = ''; clearSearchHighlights(); return; }
  $('search-count').textContent = '…';
  for (let i = 0; i < state.pages.length; i++) {
    const content = await getTextContent(state.pages[i]);
    if (search.query !== q) return;
    // match across the page text, then map back to the text items involved
    let full = ''; const spans = [];
    for (const it of content.items) {
      if (!it.str) { if (it.hasEOL) full += ' '; continue; }
      spans.push({ it, start: full.length, end: full.length + it.str.length });
      full += it.str + (it.hasEOL ? ' ' : '');
    }
    const low = full.toLowerCase();
    let pos = low.indexOf(q);
    while (pos !== -1) {
      const end = pos + q.length;
      const items = spans.filter((s) => s.end > pos && s.start < end && s.it.transform).map((s) => s.it);
      search.results.push({ page: i, items });
      pos = low.indexOf(q, end);
    }
  }
  $('search-count').textContent = search.results.length ? '' : 'No matches';
  if (search.results.length) gotoResult(0);
}
function gotoResult(i) {
  const n = search.results.length;
  if (!n) return;
  search.index = ((i % n) + n) % n;
  const r = search.results[search.index];
  $('search-count').textContent = `${search.index + 1} of ${n}`;
  highlightSearch(r.page, r.items);
}
let searchTimer;
$('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value), 250);
});
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (search.query !== e.target.value.trim().toLowerCase()) runSearch(e.target.value); else gotoResult(search.index + (e.shiftKey ? -1 : 1)); }
  if (e.key === 'Escape') closeSearch();
  e.stopPropagation();
});
$('search-next').addEventListener('click', () => gotoResult(search.index + 1));
$('search-prev').addEventListener('click', () => gotoResult(search.index - 1));
$('search-close').addEventListener('click', closeSearch);
$('btn-search').addEventListener('click', () => ($('searchbar').hidden ? openSearch() : closeSearch()));

// ------------------------------------------------------------ keyboard --
const KEY_TOOLS = { v: 'select', t: 'text', e: 'edittext', d: 'draw', h: 'highlight', r: 'shape', w: 'whiteout', s: 'sign' };
window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'o') { e.preventDefault(); doOpen(); return; }
  if (mod && k === 'p') { e.preventDefault(); doPrint(); return; }
  if (mod && k === 'n' && platform.canMultiWindow) { e.preventDefault(); platform.newWindow(); return; }
  if (mod && k === 's') { e.preventDefault(); doSave({ saveAs: e.shiftKey }); return; }
  if (mod && k === 'f') { e.preventDefault(); openSearch(); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); stepZoom(1); return; }
  if (mod && k === '-') { e.preventDefault(); stepZoom(-1); return; }
  if (mod && k === '0') { e.preventDefault(); setZoom(fitWidthZoom(), 'width'); return; }
  if (typing) return;
  if (mod && k === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) { e.preventDefault(); deleteItem(state.selectedId); return; }
  if (e.key === 'Escape') {
    if (isSignatureOpen()) closeSignature();
    else if (state.selectedId) { state.selectedId = null; emit('selection'); }
    else if (state.tool !== 'select') setTool('select');
    return;
  }
  if (!mod && !e.altKey && KEY_TOOLS[k] && state.pages.length) { chooseTool(KEY_TOOLS[k]); return; }
  if (e.key === 'PageDown') { e.preventDefault(); scrollToPage(Math.min(state.pages.length - 1, getCurrentPageIndex() + 1)); }
  if (e.key === 'PageUp') { e.preventDefault(); scrollToPage(Math.max(0, getCurrentPageIndex() - 1)); }
});

// --------------------------------------------------------- drag & drop --
let dragDepth = 0;
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (isFileDrag(e)) { dragDepth++; $('drop-overlay').hidden = false; } });
window.addEventListener('dragleave', (e) => { if (isFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const pdfs = [...e.dataTransfer.files].filter((x) => /\.pdf$/i.test(x.name) || x.type === 'application/pdf');
  if (!pdfs.length) { toast('Drop a PDF file.'); return; }
  const files = await Promise.all(pdfs.map((f) => platform.fileFromDrop(f)));
  const names = pdfs.length === 1 ? `"${pdfs[0].name}"` : `these ${pdfs.length} PDFs`;
  const elsewhere = platform.canMultiWindow ? 'open in a new window' : 'open it instead';
  if (state.pages.length && confirm(`Add the pages of ${names} to this document?\n\nOK = insert pages · Cancel = ${elsewhere}`)) {
    busy(true, 'Adding pages…');
    try {
      for (const file of files) insertPages(await loadPdf(file.data, file.name), state.pages.length);
    } finally { busy(false); }
    return;
  }
  let rest = files;
  if (!opensInNewWindow()) {
    await openDocument(files[0]);
    rest = files.slice(1);
  }
  if (platform.canMultiWindow) {
    for (const file of rest) await platform.openInNewWindow(file.path ? { path: file.path } : file);
  }
});

// ------------------------------------------------------- platform hooks --
window.addEventListener('beforeunload', (e) => {
  if (state.dirty && !platform.isDesktop && !platform.isAndroid) { e.preventDefault(); e.returnValue = ''; }
});
platform.onBackButton(() => {
  if (isSignatureOpen()) return closeSignature();
  if (!$('searchbar').hidden) return closeSearch();
  if (body.classList.contains('sidebar-open') && narrow()) return body.classList.remove('sidebar-open');
  if (state.selectedId || state.editingId) { commitEditing(); state.selectedId = null; emit('selection'); return; }
  if (state.tool !== 'select') return setTool('select');
  if (state.dirty && !confirm('You have unsaved changes. Exit anyway?')) return;
  platform.exitApp();
});
platform.initExternalOpen((file) => openDocument(file)).catch((err) => console.error(err));

setTool('select');
updateTitle();
