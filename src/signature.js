// Signature dialog: draw, type or upload a signature, and keep saved ones.
const STORE_KEY = 'swiftpdf.signatures';
const modal = document.getElementById('sig-modal');
const canvas = document.getElementById('sig-canvas');
const typed = document.getElementById('sig-typed');
const typedPreview = document.getElementById('sig-typed-preview');
const fontPick = document.getElementById('sig-font');
const uploadInput = document.getElementById('sig-upload');
const uploadPreview = document.getElementById('sig-upload-preview');
const removeBg = document.getElementById('sig-removebg');
const savedList = document.getElementById('sig-saved');
const saveCheck = document.getElementById('sig-save');
let tab = 'draw';
let penColor = '#111827';
let uploadImg = null;
let resolver = null;
let hasInk = false;

const SIG_FONTS = [
  '"Segoe Script", "Brush Script MT", "Lucida Handwriting", "Dancing Script", cursive',
  '"Brush Script MT", "Segoe Script", cursive',
  '"Lucida Handwriting", "Segoe Script", cursive',
  '"Ink Free", "Segoe Print", "Comic Sans MS", cursive',
];

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
}
function storeSaved(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* storage full */ }
}

function renderSaved() {
  const list = loadSaved();
  savedList.replaceChildren();
  savedList.parentElement.hidden = !list.length;
  list.forEach((sig, i) => {
    const b = document.createElement('button');
    b.className = 'saved-sig';
    b.title = 'Use this signature';
    const img = document.createElement('img');
    img.src = sig.src;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Remove';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      const l = loadSaved(); l.splice(i, 1); storeSaved(l); renderSaved();
    });
    b.append(img, x);
    b.addEventListener('click', () => finish(sig));
    savedList.append(b);
  });
}

// ---- draw pad ----
function sizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  hasInk = false;
}
function clearPad() { sizeCanvas(); }

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  const ctx = canvas.getContext('2d');
  const r = canvas.getBoundingClientRect();
  let last = [e.clientX - r.left, e.clientY - r.top];
  let lastT = performance.now();
  ctx.strokeStyle = penColor;
  ctx.fillStyle = penColor;
  ctx.beginPath(); ctx.arc(last[0], last[1], 1.4, 0, Math.PI * 2); ctx.fill();
  hasInk = true;
  const move = (ev) => {
    for (const ce of (ev.getCoalescedEvents?.() || [ev])) {
      const p = [ce.clientX - r.left, ce.clientY - r.top];
      const now = performance.now();
      const speed = Math.hypot(p[0] - last[0], p[1] - last[1]) / Math.max(1, now - lastT);
      ctx.lineWidth = Math.max(1.4, Math.min(3.6, 3.6 - speed * 1.2)) * (ce.pressure && ce.pointerType === 'pen' ? 0.6 + ce.pressure : 1);
      ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
      last = p; lastT = now;
    }
  };
  const up = () => {
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
});

/** Crops transparent margins; returns {src, w, h}. */
function trimCanvas(src) {
  const ctx = src.getContext('2d');
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const w = maxX - minX + 1; const h = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d').drawImage(src, minX, minY, w, h, 0, 0, w, h);
  return { src: out.toDataURL('image/png'), w, h };
}

function typedCanvas() {
  const text = typed.value.trim();
  if (!text) return null;
  const font = SIG_FONTS[+fontPick.value] || SIG_FONTS[0];
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const size = 96;
  ctx.font = `${size}px ${font}`;
  const w = Math.ceil(ctx.measureText(text).width) + 40;
  c.width = w; c.height = Math.ceil(size * 1.6);
  ctx.font = `${size}px ${font}`;
  ctx.fillStyle = penColor;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 20, c.height / 2);
  return c;
}

function uploadCanvas() {
  if (!uploadImg) return null;
  const maxW = 1200;
  const scale = Math.min(1, maxW / uploadImg.naturalWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(uploadImg.naturalWidth * scale);
  c.height = Math.round(uploadImg.naturalHeight * scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(uploadImg, 0, 0, c.width, c.height);
  if (removeBg.checked) {
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum > 200) d[i + 3] = 0;
      else if (lum > 150) d[i + 3] = Math.round(d[i + 3] * (200 - lum) / 50);
    }
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

function setTab(t) {
  tab = t;
  modal.querySelectorAll('[data-sigtab]').forEach((b) => b.classList.toggle('active', b.dataset.sigtab === t));
  modal.querySelectorAll('[data-sigpane]').forEach((p) => { p.hidden = p.dataset.sigpane !== t; });
  if (t === 'draw') requestAnimationFrame(sizeCanvas);
  if (t === 'type') { typed.focus(); updateTyped(); }
}

function updateTyped() {
  typedPreview.textContent = typed.value || 'Your Name';
  typedPreview.style.fontFamily = SIG_FONTS[+fontPick.value] || SIG_FONTS[0];
  typedPreview.style.color = penColor;
}

function finish(result) {
  modal.hidden = true;
  const r = resolver; resolver = null;
  r?.(result);
}

function apply() {
  let c = null;
  if (tab === 'draw') c = hasInk ? canvas : null;
  else if (tab === 'type') c = typedCanvas();
  else c = uploadCanvas();
  const res = c && trimCanvas(c);
  if (!res) { modal.querySelector('.sig-error').hidden = false; return; }
  if (saveCheck.checked) {
    const list = loadSaved().filter((s) => s.src !== res.src);
    list.unshift(res);
    storeSaved(list);
  }
  finish(res);
}

modal.querySelectorAll('[data-sigtab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.sigtab)));
modal.querySelectorAll('[data-pen]').forEach((b) => b.addEventListener('click', () => {
  penColor = b.dataset.pen;
  modal.querySelectorAll('[data-pen]').forEach((x) => x.classList.toggle('active', x === b));
  updateTyped();
}));
document.getElementById('sig-clear').addEventListener('click', clearPad);
document.getElementById('sig-cancel').addEventListener('click', () => finish(null));
document.getElementById('sig-apply').addEventListener('click', apply);
modal.addEventListener('pointerdown', (e) => { if (e.target === modal) finish(null); });
typed.addEventListener('input', updateTyped);
fontPick.addEventListener('change', updateTyped);
removeBg.addEventListener('change', () => { if (uploadImg) showUpload(); });
uploadInput.addEventListener('change', () => {
  const f = uploadInput.files?.[0];
  if (!f) return;
  const img = new Image();
  img.onload = () => { uploadImg = img; showUpload(); };
  img.src = URL.createObjectURL(f);
});
function showUpload() {
  const c = uploadCanvas();
  uploadPreview.replaceChildren();
  if (c) { const i = new Image(); i.src = c.toDataURL('image/png'); uploadPreview.append(i); }
}

export function isSignatureOpen() { return !modal.hidden; }
export function closeSignature() { finish(null); }

/** Opens the dialog. Resolves with {src, w, h} or null. */
export function openSignatureDialog() {
  modal.hidden = false;
  modal.querySelector('.sig-error').hidden = true;
  renderSaved();
  setTab(loadSaved().length ? tab : 'draw');
  requestAnimationFrame(sizeCanvas);
  return new Promise((res) => { resolver = res; });
}
