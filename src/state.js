// Central document state, change events and undo/redo history.

export const state = {
  docs: new Map(),      // docId -> { id, name, bytes, pdf, needsPassword }
  pages: [],            // { id, docId|null, srcIndex, rot, baseRot, view:[x1,y1,x2,y2] }
  items: [],            // annotations, see annotations.js for shapes
  forms: {},            // docId -> { fieldName: value }
  fileName: null,
  filePath: null,
  dirty: false,
  zoom: 1,
  fitMode: 'width',     // 'width' | null
  tool: 'select',
  shape: 'rect',
  selectedId: null,
  editingId: null,
  selectedPages: new Set(),
  pendingImage: null,   // { src, w, h, kind } waiting to be placed
  opts: {
    color: '#1d4ed8',
    highlight: '#facc15',
    size: 2,
    fontSize: 14,
    font: 'Helvetica',
  },
};

let counter = 0;
export const uid = (p = 'i') => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

// ---- events --------------------------------------------------------------
const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
}
export function emit(evt, arg) {
  (listeners.get(evt) || []).forEach((fn) => fn(arg));
}

// ---- history -------------------------------------------------------------
let undoStack = [];
let redoStack = [];

function snapshot() {
  return JSON.stringify({ pages: state.pages, items: state.items, forms: state.forms });
}
function restore(json) {
  const s = JSON.parse(json);
  state.pages = s.pages;
  state.items = s.items;
  state.forms = s.forms;
  state.selectedId = null;
  state.editingId = null;
  state.selectedPages = new Set();
  setDirty(true);
  emit('pages');
}

/** Call BEFORE mutating pages/items/forms so the change can be undone. */
export function beginChange() {
  undoStack.push(snapshot());
  if (undoStack.length > 150) undoStack.shift();
  redoStack = [];
  setDirty(true);
  emit('history');
}
export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  emit('history');
  return true;
}
export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  emit('history');
  return true;
}
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export function resetHistory() {
  undoStack = [];
  redoStack = [];
  emit('history');
}

export function setDirty(v) {
  state.dirty = v;
  emit('dirty', v);
}

export const getItem = (id) => state.items.find((it) => it.id === id);
export const getPage = (id) => state.pages.find((p) => p.id === id);
export const pageItems = (pageId) => state.items.filter((it) => it.pageId === pageId);
