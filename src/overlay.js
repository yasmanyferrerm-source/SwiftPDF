// Draws annotation items on top of each page and handles selecting, moving,
// resizing, deleting and editing them.
import { state, emit, beginChange, getItem, pageItems } from './state.js';
import { viewRotation } from './pdf.js';

const SVGNS = 'http://www.w3.org/2000/svg';
export const LINE_H = 1.2;     // text line height (x font size)
export const BASELINE = 0.93;  // baseline offset from line top (x font size)
export const FONT_CSS = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", Roboto, sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", "Noto Serif", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", "Droid Sans Mono", monospace',
};

export const SHAPE_TYPES = new Set(['ink', 'highlight', 'rect', 'ellipse', 'line', 'whiteout']);
export const BOX_TYPES = new Set(['text', 'image']);

export const textLines = (it) => (it.text || '').split('\n');
export const textHeight = (it) => Math.max(1, textLines(it).length) * LINE_H * it.fontSize;

const toView = (vp, x, y) => vp.convertToViewportPoint(x, y);
const toPdf = (vp, x, y) => vp.convertToPdfPoint(x, y);

function el(tag, attrs = {}, ns) {
  const e = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function rectView(vp, it) {
  const [ax, ay] = toView(vp, it.x1, it.y1);
  const [bx, by] = toView(vp, it.x2, it.y2);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

/** View-space bounding box of any item. */
export function itemViewBox(vp, it, entry) {
  if (it.type === 'ink') {
    const pts = it.points.map(([x, y]) => toView(vp, x, y));
    const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  if (SHAPE_TYPES.has(it.type)) return rectView(vp, it);
  const f = boxFrame(vp, it, entry);
  return { x: f.left, y: f.top, w: f.width, h: f.height };
}

/** Frame (css) for a text/image box item. */
export function boxFrame(vp, it, entry) {
  const z = vp.scale;
  const [vx, vy] = toView(vp, it.ax, it.ay);
  const h = it.type === 'text' ? textHeight(it) : it.h;
  return {
    left: vx,
    top: vy - h * z,
    width: (it.w || 10) * z,
    height: h * z,
    angle: (viewRotation(entry) - (it.rot || 0) + 360) % 360,
  };
}

// --------------------------------------------------------------------------
export function renderOverlay(pv) {
  const { svg, itemLayer, vp, entry } = pv;
  const z = vp.scale;
  svg.replaceChildren();
  itemLayer.replaceChildren();
  svg.setAttribute('width', vp.width);
  svg.setAttribute('height', vp.height);

  const items = pageItems(entry.id);

  // White covers for "edited" original text go underneath everything.
  for (const it of items) {
    if (it.type === 'text' && it.cover) {
      const r = rectView(vp, it.cover);
      svg.append(el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: '#fff', class: 'cover' }, SVGNS));
    }
  }

  for (const it of items) {
    const selected = it.id === state.selectedId;
    if (SHAPE_TYPES.has(it.type)) {
      const g = el('g', { 'data-id': it.id, class: `shape${selected ? ' selected' : ''}` }, SVGNS);
      const sw = Math.max(1, (it.size || 2) * z);
      if (it.type === 'ink') {
        const pts = it.points.map(([x, y]) => toView(vp, x, y).map((n) => n.toFixed(1)).join(',')).join(' ');
        g.append(el('polyline', { points: pts, fill: 'none', stroke: it.color, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, SVGNS));
        g.append(el('polyline', { points: pts, class: 'hit', 'stroke-width': Math.max(sw, 16) }, SVGNS));
      } else if (it.type === 'line') {
        const [ax, ay] = toView(vp, it.x1, it.y1); const [bx, by] = toView(vp, it.x2, it.y2);
        g.append(el('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: it.color, 'stroke-width': sw, 'stroke-linecap': 'round' }, SVGNS));
        g.append(el('line', { x1: ax, y1: ay, x2: bx, y2: by, class: 'hit', 'stroke-width': Math.max(sw, 16) }, SVGNS));
      } else {
        const r = rectView(vp, it);
        if (it.type === 'highlight') {
          g.append(el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: it.color, 'fill-opacity': 0.4, class: 'hl' }, SVGNS));
        } else if (it.type === 'whiteout') {
          g.append(el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: '#fff', class: 'whiteout' }, SVGNS));
        } else if (it.type === 'rect') {
          g.append(el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: 'none', stroke: it.color, 'stroke-width': sw }, SVGNS));
        } else if (it.type === 'ellipse') {
          g.append(el('ellipse', { cx: r.x + r.w / 2, cy: r.y + r.h / 2, rx: r.w / 2, ry: r.h / 2, fill: 'none', stroke: it.color, 'stroke-width': sw }, SVGNS));
        }
        g.append(el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, class: 'hit area' }, SVGNS));
      }
      svg.append(g);
      if (selected) {
        const b = itemViewBox(vp, it, entry);
        const pad = 6;
        svg.append(el('rect', { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, class: 'sel-box' }, SVGNS));
        itemLayer.append(deleteButton(it, pv, b.x + b.w + pad, b.y - pad));
      }
    } else if (BOX_TYPES.has(it.type)) {
      itemLayer.append(boxElement(it, pv, selected));
    }
  }
}

function deleteButton(it, pv, x, y) {
  const b = el('button', { class: 'del-btn', title: 'Delete', 'aria-label': 'Delete' });
  b.innerHTML = '&times;';
  if (x !== undefined) { b.style.left = `${x}px`; b.style.top = `${y}px`; }
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => { e.stopPropagation(); deleteItem(it.id); });
  return b;
}

function boxElement(it, pv, selected) {
  const f = boxFrame(pv.vp, it, pv.entry);
  const z = pv.vp.scale;
  const div = el('div', { class: `box ${it.type}${selected ? ' selected' : ''}`, 'data-id': it.id });
  Object.assign(div.style, {
    left: `${f.left}px`, top: `${f.top}px`, height: `${f.height}px`,
    transform: f.angle ? `rotate(${f.angle}deg)` : '',
  });
  if (it.type === 'text') {
    const t = el('div', { class: 'txt' });
    t.textContent = it.text;
    Object.assign(t.style, {
      fontSize: `${it.fontSize * z}px`,
      lineHeight: String(LINE_H),
      fontFamily: FONT_CSS[it.font] || FONT_CSS.Helvetica,
      color: it.color,
      minHeight: `${f.height}px`,
    });
    div.append(t);
    if (state.editingId === it.id) {
      div.classList.add('editing');
      t.setAttribute('contenteditable', 'plaintext-only');
      if (t.contentEditable !== 'plaintext-only') t.setAttribute('contenteditable', 'true');
      t.spellcheck = false;
      queueMicrotask(() => {
        t.focus();
        const range = document.createRange();
        range.selectNodeContents(t);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
      t.addEventListener('input', () => {
        div.style.height = '';
        t.style.minHeight = '';
      });
      t.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); t.blur(); }
        e.stopPropagation();
      });
      t.addEventListener('blur', () => finishEdit(it.id, t, pv));
    }
    // measure width once it is laid out
    requestAnimationFrame(() => {
      const w = t.offsetWidth / z;
      if (w > 0 && state.editingId !== it.id) it.w = w;
    });
  } else {
    div.style.width = `${f.width}px`;
    const img = el('img', { src: it.src, draggable: 'false', alt: it.kind || 'image' });
    div.append(img);
    if (selected) {
      const h = el('div', { class: 'resize-handle', title: 'Resize' });
      h.addEventListener('pointerdown', (e) => startResize(e, it, pv, div));
      div.append(h);
    }
  }
  if (selected && state.editingId !== it.id) div.append(deleteButton(it, pv));
  return div;
}

// --------------------------------------------------------------------------
export function select(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  emit('selection');
}

export function deleteItem(id) {
  const it = getItem(id);
  if (!it) return;
  beginChange();
  state.items = state.items.filter((x) => x.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  if (state.editingId === id) state.editingId = null;
  emit('items', it.pageId);
  emit('selection');
}

export function startEdit(id) {
  const it = getItem(id);
  if (!it || it.type !== 'text') return;
  state.selectedId = id;
  state.editingId = id;
  emit('items', it.pageId);
  emit('selection');
}

function finishEdit(id, t, pv) {
  if (state.editingId !== id) return;
  const it = getItem(id);
  state.editingId = null;
  if (!it) return;
  const text = (t.innerText || '').replace(/ /g, ' ').replace(/\n+$/, '');
  if (!text.trim() && !it.cover) {
    // remove empty new text boxes without leaving a history step behind
    state.items = state.items.filter((x) => x.id !== id);
    state.selectedId = null;
  } else if (text !== it.text) {
    if (!it._new) beginChange();
    it.text = text;
  }
  delete it._new;
  if (t.offsetWidth) it.w = t.offsetWidth / pv.vp.scale;
  emit('items', it.pageId);
  emit('selection');
}

/** pointerdown on an existing item while in select/text tool */
export function handleItemPointerDown(e, pv) {
  const target = e.target.closest('[data-id]');
  if (!target) return false;
  const it = getItem(target.dataset.id);
  if (!it) return false;
  if (state.editingId === it.id) { e.stopPropagation(); return true; }
  e.stopPropagation();
  e.preventDefault();
  const wasSelected = state.selectedId === it.id;
  if (!wasSelected) {
    state.selectedId = it.id;
    target.classList.add('selected');
  }

  const vp = pv.vp;
  const sx = e.clientX; const sy = e.clientY;
  const orig = JSON.parse(JSON.stringify(it));
  let moved = false;

  const onMove = (ev) => {
    const dx = ev.clientX - sx; const dy = ev.clientY - sy;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) { moved = true; beginChange(); }
    if (target instanceof SVGElement) target.setAttribute('transform', `translate(${dx} ${dy})`);
    else target.style.translate = `${dx}px ${dy}px`;
    target._delta = [dx, dy];
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (moved && target._delta) {
      const [dx, dy] = target._delta;
      const shift = (x, y) => { const [vx, vy] = toView(vp, x, y); return toPdf(vp, vx + dx, vy + dy); };
      if (it.type === 'ink') it.points = orig.points.map(([x, y]) => shift(x, y));
      else if (SHAPE_TYPES.has(it.type)) {
        [it.x1, it.y1] = shift(orig.x1, orig.y1);
        [it.x2, it.y2] = shift(orig.x2, orig.y2);
      } else {
        [it.ax, it.ay] = shift(orig.ax, orig.ay);
      }
    } else if (wasSelected && it.type === 'text') {
      startEdit(it.id);
      return;
    }
    emit('items', it.pageId);
    if (!wasSelected) emit('selection');
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  return true;
}

function startResize(e, it, pv, div) {
  e.stopPropagation();
  e.preventDefault();
  const z = pv.vp.scale;
  const sx = e.clientX; const sy = e.clientY;
  const orig = { w: it.w, h: it.h, ax: it.ax, ay: it.ay };
  const angle = (boxFrame(pv.vp, it, pv.entry).angle * Math.PI) / 180;
  const ratio = orig.h / orig.w;
  let started = false;
  let nw = orig.w; let nh = orig.h;

  const onMove = (ev) => {
    if (!started) { started = true; beginChange(); }
    const dx = ev.clientX - sx; const dy = ev.clientY - sy;
    // delta in the box's own (unrotated) frame
    const lx = dx * Math.cos(-angle) - dy * Math.sin(-angle);
    nw = Math.max(12, orig.w + lx / z);
    nh = nw * ratio;
    div.style.width = `${nw * z}px`;
    div.style.height = `${nh * z}px`;
    div.style.top = `${parseFloat(div.style.top)}px`;
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (!started) return;
    // keep the top-left corner fixed: anchor (bottom-left) moves down by dh in the box frame
    const dh = nh - orig.h;
    const r = ((it.rot || 0) * Math.PI) / 180;
    it.w = nw;
    it.h = nh;
    it.ax = orig.ax + dh * Math.sin(r);
    it.ay = orig.ay - dh * Math.cos(r);
    emit('items', it.pageId);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}
