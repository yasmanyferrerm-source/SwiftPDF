// Page thumbnails sidebar + page organization (rotate, delete, reorder, insert).
import { state, emit, on, beginChange } from './state.js';
import { getViewport, renderPageToCanvas, blankPageEntry, viewRotation } from './pdf.js';
import { scrollToPage, getCurrentPageIndex } from './viewer.js';

const list = document.getElementById('thumbs');
const THUMB_W = 116;
let observer = null;
let lastClicked = null;

export function buildThumbs() {
  if (observer) observer.disconnect();
  list.replaceChildren();
  observer = new IntersectionObserver(onIntersect, { root: list, rootMargin: '300px 0px' });
  state.pages.forEach((entry, index) => {
    const r = viewRotation(entry);
    const w = entry.view[2] - entry.view[0]; const h = entry.view[3] - entry.view[1];
    const ratio = r % 180 === 0 ? h / w : w / h;
    const t = document.createElement('div');
    t.className = 'thumb';
    t.dataset.pageId = entry.id;
    t.draggable = true;
    t.classList.toggle('picked', state.selectedPages.has(entry.id));
    t.classList.toggle('current', index === getCurrentPageIndex());
    const holder = document.createElement('div');
    holder.className = 'thumb-img';
    holder.style.height = `${Math.round(THUMB_W * ratio)}px`;
    const canvas = document.createElement('canvas');
    holder.append(canvas);
    const foot = document.createElement('label');
    foot.className = 'thumb-foot';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selectedPages.has(entry.id);
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => togglePick(entry.id, cb.checked));
    const num = document.createElement('span');
    num.textContent = index + 1;
    foot.append(cb, num);
    t.append(holder, foot);
    t._canvas = canvas;
    t._entry = entry;
    t.addEventListener('click', (e) => onThumbClick(e, entry, index));
    t.addEventListener('dragstart', (e) => {
      const ids = state.selectedPages.has(entry.id) ? [...state.selectedPages] : [entry.id];
      e.dataTransfer.setData('text/x-swiftpdf-pages', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
      t.classList.add('dragging');
    });
    t.addEventListener('dragend', () => t.classList.remove('dragging'));
    t.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/x-swiftpdf-pages')) return;
      e.preventDefault();
      const rect = t.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      t.classList.toggle('drop-before', !after);
      t.classList.toggle('drop-after', after);
    });
    t.addEventListener('dragleave', () => t.classList.remove('drop-before', 'drop-after'));
    t.addEventListener('drop', (e) => {
      const raw = e.dataTransfer.getData('text/x-swiftpdf-pages');
      t.classList.remove('drop-before', 'drop-after');
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = t.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      moveIdsTo(JSON.parse(raw), entry.id, after);
    });
    list.append(t);
    observer.observe(t);
  });
}

async function onIntersect(entries) {
  for (const e of entries) {
    if (!e.isIntersecting || e.target._done) continue;
    e.target._done = true;
    const entry = e.target._entry;
    const w = viewRotation(entry) % 180 === 0 ? entry.view[2] - entry.view[0] : entry.view[3] - entry.view[1];
    try {
      const vp = await getViewport(entry, THUMB_W / w);
      const task = await renderPageToCanvas(entry, e.target._canvas, vp, { dprCap: 1.5 });
      await task?.promise;
    } catch { /* ignore cancelled */ }
  }
}

function onThumbClick(e, entry, index) {
  if (e.ctrlKey || e.metaKey) {
    togglePick(entry.id, !state.selectedPages.has(entry.id));
  } else if (e.shiftKey && lastClicked != null) {
    const [a, b] = [Math.min(lastClicked, index), Math.max(lastClicked, index)];
    state.selectedPages = new Set(state.pages.slice(a, b + 1).map((p) => p.id));
    syncPicks();
  } else {
    scrollToPage(index, { smooth: false });
    if (window.innerWidth < 760) emit('closeSidebar');
  }
  lastClicked = index;
}

function togglePick(id, on) {
  if (on) state.selectedPages.add(id); else state.selectedPages.delete(id);
  syncPicks();
}

export function syncPicks() {
  for (const t of list.children) {
    const on = state.selectedPages.has(t.dataset.pageId);
    t.classList.toggle('picked', on);
    const cb = t.querySelector('input'); if (cb) cb.checked = on;
  }
  emit('pagePicks', state.selectedPages.size);
}

export function selectAllPages(on = true) {
  state.selectedPages = on ? new Set(state.pages.map((p) => p.id)) : new Set();
  syncPicks();
}

on('currentPage', (idx) => {
  [...list.children].forEach((t, i) => t.classList.toggle('current', i === idx));
  const cur = list.children[idx];
  if (cur && list.offsetParent) {
    const top = cur.offsetTop - list.offsetTop; const bottom = top + cur.offsetHeight;
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) list.scrollTop = top - 20;
  }
});

// ------------------------------------------------------------- actions --
/** Pages an action applies to: ticked pages, or the current page. */
export function targetIds() {
  if (state.selectedPages.size) return [...state.selectedPages];
  const cur = state.pages[getCurrentPageIndex()];
  return cur ? [cur.id] : [];
}

export function rotatePages(delta) {
  const ids = new Set(targetIds());
  if (!ids.size) return;
  beginChange();
  for (const p of state.pages) if (ids.has(p.id)) p.rot = (((p.rot + delta) % 360) + 360) % 360;
  emit('pages');
}

export function deletePages() {
  const ids = new Set(targetIds());
  if (!ids.size) return false;
  if (ids.size >= state.pages.length) return 'all';
  beginChange();
  state.pages = state.pages.filter((p) => !ids.has(p.id));
  state.items = state.items.filter((it) => !ids.has(it.pageId));
  state.selectedPages = new Set();
  emit('pages');
  return true;
}

export function movePages(dir) {
  const ids = new Set(targetIds());
  if (!ids.size) return;
  const pages = state.pages.slice();
  const order = dir < 0 ? pages.map((_, i) => i) : pages.map((_, i) => pages.length - 1 - i);
  let changed = false;
  for (const i of order) {
    const j = i + dir;
    if (!ids.has(pages[i].id) || j < 0 || j >= pages.length || ids.has(pages[j].id)) continue;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    changed = true;
  }
  if (!changed) return;
  beginChange();
  state.pages = pages;
  emit('pages');
  const first = state.pages.findIndex((p) => ids.has(p.id));
  requestAnimationFrame(() => scrollToPage(first));
}

function moveIdsTo(ids, targetId, after) {
  if (ids.includes(targetId)) return;
  const set = new Set(ids);
  const moving = state.pages.filter((p) => set.has(p.id));
  const rest = state.pages.filter((p) => !set.has(p.id));
  let idx = rest.findIndex((p) => p.id === targetId);
  if (after) idx += 1;
  beginChange();
  rest.splice(idx, 0, ...moving);
  state.pages = rest;
  emit('pages');
}

export function insertPages(entries, atIndex = getCurrentPageIndex() + 1) {
  beginChange();
  state.pages.splice(Math.min(atIndex, state.pages.length), 0, ...entries);
  emit('pages');
  requestAnimationFrame(() => scrollToPage(Math.min(atIndex, state.pages.length - 1)));
}

export function insertBlankPage() {
  const cur = state.pages[getCurrentPageIndex()];
  const [x1, y1, x2, y2] = cur ? cur.view : [0, 0, 612, 792];
  const turned = cur && viewRotation(cur) % 180 !== 0;
  insertPages([turned ? blankPageEntry(y2 - y1, x2 - x1) : blankPageEntry(x2 - x1, y2 - y1)]);
}
