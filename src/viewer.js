// Continuous-scroll page viewer + creation tools (text, draw, shapes, place image).
import { state, emit, on, beginChange, uid, getItem } from './state.js';
import { getViewport, viewportSync, renderPageToCanvas, viewRotation, getTextContent, pdfjsLib } from './pdf.js';
import { renderOverlay, handleItemPointerDown, startEdit, LINE_H, textHeight } from './overlay.js';
import { renderForms } from './forms.js';

const viewerEl = document.getElementById('viewer');
const pagesEl = document.getElementById('pages');
export const pageViews = new Map(); // pageId -> pv
let observer = null;
let currentPageIndex = 0;

const SVGNS = 'http://www.w3.org/2000/svg';

export function getCurrentPageIndex() { return currentPageIndex; }

// ---------------------------------------------------------------- layout --
export function buildPages({ keepScroll = true } = {}) {
  const anchor = keepScroll ? scrollAnchor() : null;
  if (observer) observer.disconnect();
  for (const pv of pageViews.values()) pv.task?.cancel?.();
  pageViews.clear();
  pagesEl.replaceChildren();
  observer = new IntersectionObserver(onIntersect, { root: viewerEl, rootMargin: '800px 0px' });

  state.pages.forEach((entry, index) => {
    const vp = viewportSync(entry, state.zoom);
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.pageId = entry.id;
    const page = document.createElement('div');
    page.className = 'page';
    page.style.width = `${vp.width}px`;
    page.style.height = `${vp.height}px`;
    const canvas = document.createElement('canvas');
    const textLayer = document.createElement('div');
    textLayer.className = 'text-layer';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.classList.add('shape-layer');
    const itemLayer = document.createElement('div');
    itemLayer.className = 'item-layer';
    const formLayer = document.createElement('div');
    formLayer.className = 'form-layer';
    const searchLayer = document.createElement('div');
    searchLayer.className = 'search-layer';
    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `${index + 1}`;
    page.append(canvas, searchLayer, svg, textLayer, formLayer, itemLayer);
    wrap.append(page, label);
    pagesEl.append(wrap);

    const pv = { entry, wrap, el: page, canvas, svg, itemLayer, formLayer, textLayer, searchLayer, vp, rendered: false, index };
    pageViews.set(entry.id, pv);
    page.addEventListener('pointerdown', (e) => onPagePointerDown(e, pv));
    renderOverlay(pv);
    renderForms(pv);
    if (state.tool === 'edittext') renderTextHits(pv);
    observer.observe(wrap);
  });

  if (anchor) restoreScroll(anchor);
  updateCurrentPage();
}

function onIntersect(entries) {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const pv = pageViews.get(e.target.dataset.pageId);
    if (pv && !pv.rendered) renderCanvas(pv);
  }
}

async function renderCanvas(pv) {
  pv.rendered = true;
  try {
    const vp = await getViewport(pv.entry, state.zoom);
    if (pageViews.get(pv.entry.id) !== pv) return;
    pv.task = await renderPageToCanvas(pv.entry, pv.canvas, vp);
    await pv.task?.promise;
  } catch (err) {
    if (!(err instanceof pdfjsLib.RenderingCancelledException) && err?.name !== 'RenderingCancelledException') console.error(err);
  }
}

function scrollAnchor() {
  const pv = [...pageViews.values()][currentPageIndex];
  if (!pv) return null;
  const off = viewerEl.scrollTop - pv.wrap.offsetTop;
  return { index: currentPageIndex, frac: off / Math.max(1, pv.wrap.offsetHeight), left: viewerEl.scrollLeft / Math.max(1, viewerEl.scrollWidth) };
}
function restoreScroll(a) {
  const pv = [...pageViews.values()][Math.min(a.index, pageViews.size - 1)];
  if (!pv) return;
  viewerEl.scrollTop = pv.wrap.offsetTop + a.frac * pv.wrap.offsetHeight;
  viewerEl.scrollLeft = a.left * viewerEl.scrollWidth;
}

export function updateCurrentPage() {
  const mid = viewerEl.scrollTop + viewerEl.clientHeight * 0.35;
  let idx = 0;
  for (const pv of pageViews.values()) {
    if (pv.wrap.offsetTop <= mid) idx = pv.index; else break;
  }
  if (idx !== currentPageIndex || !updateCurrentPage.init) {
    updateCurrentPage.init = true;
    currentPageIndex = idx;
    emit('currentPage', idx);
  }
}
viewerEl.addEventListener('scroll', () => updateCurrentPage(), { passive: true });

export function scrollToPage(index, { smooth = false } = {}) {
  const pv = [...pageViews.values()][index];
  if (!pv) return;
  viewerEl.scrollTo({ top: pv.wrap.offsetTop - 8, behavior: smooth ? 'smooth' : 'auto' });
  currentPageIndex = index;
  emit('currentPage', index);
}

export function refreshPageOverlay(pageId) {
  const pv = pageViews.get(pageId);
  if (pv) renderOverlay(pv);
}

// ------------------------------------------------------------------ zoom --
export function fitWidthZoom() {
  const avail = viewerEl.clientWidth - (window.innerWidth < 700 ? 16 : 48);
  let maxW = 0;
  for (const p of state.pages) {
    const w = viewRotation(p) % 180 === 0 ? p.view[2] - p.view[0] : p.view[3] - p.view[1];
    maxW = Math.max(maxW, w);
  }
  return maxW ? Math.max(0.25, Math.min(4, avail / maxW)) : 1;
}

export function setZoom(z, fitMode = null) {
  state.fitMode = fitMode;
  state.zoom = Math.max(0.25, Math.min(5, z));
  buildPages();
  emit('zoom', state.zoom);
}

// -------------------------------------------------------------- tools --
function localPoint(e, pv) {
  const r = pv.el.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function onPagePointerDown(e, pv) {
  if (e.button !== undefined && e.button !== 0) return;
  const tool = state.tool;

  if ((tool === 'select' || tool === 'text') && handleItemPointerDown(e, pv)) return;

  if (state.editingId) {
    document.activeElement?.blur?.();
  }

  switch (tool) {
    case 'select':
      if (state.selectedId) { state.selectedId = null; emit('selection'); emit('items', pv.entry.id); }
      return;
    case 'text':
    case 'date':
      e.preventDefault();
      createTextAt(pv, localPoint(e, pv), tool === 'date' ? todayString() : '');
      return;
    case 'place':
      e.preventDefault();
      placeImageAt(pv, localPoint(e, pv));
      return;
    case 'draw':
      startInk(e, pv);
      return;
    case 'highlight':
    case 'whiteout':
    case 'shape':
      startShape(e, pv, tool === 'shape' ? state.shape : tool);
      return;
    default:
  }
}

function todayString() {
  return new Date().toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function createTextAt(pv, [vx, vy], text) {
  const z = pv.vp.scale;
  const fs = state.opts.fontSize;
  const h = LINE_H * fs;
  const top = vy - (h * z) / 2;
  const [ax, ay] = pv.vp.convertToPdfPoint(vx, top + h * z);
  beginChange();
  const it = {
    id: uid(), pageId: pv.entry.id, type: 'text', ax, ay, w: 40, h, rot: viewRotation(pv.entry),
    text, fontSize: fs, color: state.opts.color, font: state.opts.font, _new: !text,
  };
  state.items.push(it);
  if (text) {
    state.selectedId = it.id;
    emit('items', pv.entry.id);
    emit('selection');
    setTool('select');
  } else {
    startEdit(it.id);
  }
}

function placeImageAt(pv, [vx, vy]) {
  const pend = state.pendingImage;
  if (!pend) return;
  const z = pv.vp.scale;
  const baseW = pend.kind === 'signature' ? 170 : 200;
  const pageW = Math.abs(pv.vp.width / z);
  const w = Math.min(baseW, pageW * 0.8);
  const h = w * (pend.h / pend.w);
  const [ax, ay] = pv.vp.convertToPdfPoint(vx - (w * z) / 2, vy + (h * z) / 2);
  beginChange();
  const it = { id: uid(), pageId: pv.entry.id, type: 'image', kind: pend.kind, src: pend.src, ax, ay, w, h, rot: viewRotation(pv.entry) };
  state.items.push(it);
  state.selectedId = it.id;
  state.pendingImage = null;
  setTool('select');
  emit('items', pv.entry.id);
  emit('selection');
}

function startInk(e, pv) {
  e.preventDefault();
  const pts = [localPoint(e, pv)];
  const poly = document.createElementNS(SVGNS, 'polyline');
  const z = pv.vp.scale;
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', state.opts.color);
  poly.setAttribute('stroke-width', Math.max(1, state.opts.size * z));
  poly.setAttribute('stroke-linecap', 'round');
  poly.setAttribute('stroke-linejoin', 'round');
  pv.svg.append(poly);
  pv.el.setPointerCapture(e.pointerId);
  const draw = () => poly.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
  draw();
  const move = (ev) => {
    const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    for (const ce of (evs.length ? evs : [ev])) pts.push(localPoint(ce, pv));
    draw();
  };
  const up = () => {
    pv.el.removeEventListener('pointermove', move);
    pv.el.removeEventListener('pointerup', up);
    pv.el.removeEventListener('pointercancel', up);
    if (pts.length === 1) pts.push([pts[0][0] + 0.5, pts[0][1] + 0.5]);
    beginChange();
    state.items.push({
      id: uid(), pageId: pv.entry.id, type: 'ink', color: state.opts.color, size: state.opts.size,
      points: simplify(pts, 0.6).map(([x, y]) => pv.vp.convertToPdfPoint(x, y).map((n) => +n.toFixed(2))),
    });
    emit('items', pv.entry.id);
  };
  pv.el.addEventListener('pointermove', move);
  pv.el.addEventListener('pointerup', up);
  pv.el.addEventListener('pointercancel', up);
}

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1]) >= tol) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function startShape(e, pv, type) {
  e.preventDefault();
  const [sx, sy] = localPoint(e, pv);
  const z = pv.vp.scale;
  const tag = type === 'ellipse' ? 'ellipse' : type === 'line' ? 'line' : 'rect';
  const node = document.createElementNS(SVGNS, tag);
  const color = type === 'highlight' ? state.opts.highlight : state.opts.color;
  if (type === 'highlight') { node.setAttribute('fill', color); node.setAttribute('fill-opacity', '0.4'); }
  else if (type === 'whiteout') { node.setAttribute('fill', '#fff'); node.setAttribute('stroke', '#94a3b8'); node.setAttribute('stroke-dasharray', '4 3'); }
  else { node.setAttribute('fill', 'none'); node.setAttribute('stroke', color); node.setAttribute('stroke-width', Math.max(1, state.opts.size * z)); node.setAttribute('stroke-linecap', 'round'); }
  pv.svg.append(node);
  pv.el.setPointerCapture(e.pointerId);
  let ex = sx; let ey = sy;
  const draw = () => {
    if (tag === 'line') {
      node.setAttribute('x1', sx); node.setAttribute('y1', sy); node.setAttribute('x2', ex); node.setAttribute('y2', ey);
    } else if (tag === 'ellipse') {
      node.setAttribute('cx', (sx + ex) / 2); node.setAttribute('cy', (sy + ey) / 2);
      node.setAttribute('rx', Math.abs(ex - sx) / 2); node.setAttribute('ry', Math.abs(ey - sy) / 2);
    } else {
      node.setAttribute('x', Math.min(sx, ex)); node.setAttribute('y', Math.min(sy, ey));
      node.setAttribute('width', Math.abs(ex - sx)); node.setAttribute('height', Math.abs(ey - sy));
    }
  };
  draw();
  const move = (ev) => { [ex, ey] = localPoint(ev, pv); draw(); };
  const up = () => {
    pv.el.removeEventListener('pointermove', move);
    pv.el.removeEventListener('pointerup', up);
    pv.el.removeEventListener('pointercancel', up);
    node.remove();
    if (Math.hypot(ex - sx, ey - sy) < 4) return;
    const [x1, y1] = pv.vp.convertToPdfPoint(sx, sy);
    const [x2, y2] = pv.vp.convertToPdfPoint(ex, ey);
    beginChange();
    state.items.push({ id: uid(), pageId: pv.entry.id, type, x1, y1, x2, y2, color, size: state.opts.size });
    emit('items', pv.entry.id);
  };
  pv.el.addEventListener('pointermove', move);
  pv.el.addEventListener('pointerup', up);
  pv.el.addEventListener('pointercancel', up);
}

export function setTool(tool) {
  if (state.editingId) document.activeElement?.blur?.();
  state.tool = tool;
  if (tool !== 'place') state.pendingImage = null;
  document.body.dataset.tool = tool;
  for (const pv of pageViews.values()) {
    if (tool === 'edittext') renderTextHits(pv);
    else pv.textLayer.replaceChildren();
  }
  emit('tool', tool);
}

// ------------------------------------------------ edit existing text ----
function fontFromStyle(style) {
  const fam = `${style?.fontFamily || ''}`.toLowerCase();
  if (fam.includes('mono') || fam.includes('courier')) return 'Courier';
  if (fam.includes('serif') && !fam.includes('sans')) return 'Times';
  return 'Helvetica';
}

async function renderTextHits(pv) {
  pv.textLayer.replaceChildren();
  const vp = pv.vp;
  const content = await getTextContent(pv.entry);
  if (state.tool !== 'edittext' || pageViews.get(pv.entry.id) !== pv) return;
  for (const t of content.items) {
    if (!t.str || !t.str.trim() || !t.transform) continue;
    const [a, b, c, d, e, f] = t.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) continue; // skip rotated/mirrored text
    const fs = Math.abs(d) || Math.hypot(c, d);
    const box = { x1: e - 0.5, y1: f - 0.24 * fs, x2: e + t.width + 0.5, y2: f + 0.9 * fs };
    const p1 = vp.convertToViewportPoint(box.x1, box.y1);
    const p2 = vp.convertToViewportPoint(box.x2, box.y2);
    const span = document.createElement('div');
    span.className = 'text-hit';
    Object.assign(span.style, {
      left: `${Math.min(p1[0], p2[0])}px`, top: `${Math.min(p1[1], p2[1])}px`,
      width: `${Math.abs(p2[0] - p1[0])}px`, height: `${Math.abs(p2[1] - p1[1])}px`,
    });
    span.title = 'Click to edit this text';
    span.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (state.editingId) document.activeElement?.blur?.();
      beginChange();
      const it = {
        id: uid(), pageId: pv.entry.id, type: 'text', text: t.str, fontSize: +fs.toFixed(2),
        color: '#000000', font: fontFromStyle(content.styles?.[t.fontName]), rot: 0,
        ax: e, ay: f - (LINE_H - 0.93) * fs, w: t.width, h: LINE_H * fs, cover: box, _new: true,
      };
      state.items.push(it);
      span.remove();
      startEdit(it.id);
    });
    pv.textLayer.append(span);
  }
}

// ------------------------------------------------------------- search ----
export async function highlightSearch(pageIndex, matches) {
  for (const pv of pageViews.values()) pv.searchLayer.replaceChildren();
  const pv = [...pageViews.values()][pageIndex];
  if (!pv) return;
  for (const t of matches) {
    const [, , c, d, e, f] = t.transform;
    const fs = Math.hypot(c, d);
    const p1 = pv.vp.convertToViewportPoint(e, f - 0.24 * fs);
    const p2 = pv.vp.convertToViewportPoint(e + t.width, f + 0.9 * fs);
    const box = document.createElement('div');
    box.className = 'search-hit';
    Object.assign(box.style, {
      left: `${Math.min(p1[0], p2[0])}px`, top: `${Math.min(p1[1], p2[1])}px`,
      width: `${Math.abs(p2[0] - p1[0])}px`, height: `${Math.abs(p2[1] - p1[1])}px`,
    });
    pv.searchLayer.append(box);
  }
  const first = pv.searchLayer.firstChild;
  if (first) {
    const top = pv.wrap.offsetTop + parseFloat(first.style.top) - viewerEl.clientHeight / 3;
    viewerEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  } else scrollToPage(pageIndex);
}
export function clearSearchHighlights() {
  for (const pv of pageViews.values()) pv.searchLayer.replaceChildren();
}

on('items', (pageId) => refreshPageOverlay(pageId));
let prevSelPage = null;
on('selection', () => {
  if (state.editingId) return;
  const it = state.selectedId ? getItem(state.selectedId) : null;
  const pages = new Set([prevSelPage, it?.pageId].filter(Boolean));
  prevSelPage = it?.pageId || null;
  for (const id of pages) refreshPageOverlay(id);
});

export { getItem, textHeight };
