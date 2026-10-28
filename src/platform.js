// Platform bridge: Windows (Electron), Android (Capacitor) or a plain browser.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';

const desktop = typeof window !== 'undefined' ? window.swiftpdf : null;
export const isDesktop = !!desktop;
export const isAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
export const platformName = isDesktop ? 'desktop' : isAndroid ? 'android' : 'web';

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', () => {
      const f = input.files?.[0] || null;
      input.remove();
      resolve(f);
    });
    input.addEventListener('cancel', () => { input.remove(); resolve(null); });
    input.click();
  });
}

/** @returns {Promise<{name, path, data: Uint8Array} | null>} single file (used for "insert pages") */
export async function openPdfFile() {
  if (isDesktop) {
    const paths = await desktop.openDialog();
    return paths && paths.length ? desktop.readFile(paths[0]) : null;
  }
  const f = await pickFile('application/pdf,.pdf');
  if (!f) return null;
  return { name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) };
}

/**
 * Lets the user pick one or more PDFs.
 * @returns {Promise<Array<() => Promise<{name, path, data}>>>} loaders, in the order picked
 */
export async function pickPdfFiles() {
  if (isDesktop) {
    const paths = (await desktop.openDialog()) || [];
    return paths.map((p) => Object.assign(() => desktop.readFile(p), { path: p }));
  }
  const f = await pickFile('application/pdf,.pdf');
  if (!f) return [];
  return [async () => ({ name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) })];
}

/** Desktop only: opens a PDF ({path} or {name, data}) in a new window. */
export const canMultiWindow = isDesktop;
export function openInNewWindow(file) { return desktop.openInNewWindow(file); }
export function newWindow() { return desktop.newWindow(); }
export function setHasDoc(v) { if (isDesktop) desktop.setHasDoc(v); }

export const canPrint = !isAndroid;
/** Shows the system print dialog for what is currently in the print view. */
export async function printView(jobName) {
  if (isDesktop) return desktop.print(jobName);
  window.print();
  return { success: true };
}

export async function fileFromDrop(file) {
  const path = isDesktop ? desktop.pathForFile(file) : null;
  return { name: file.name, path, data: new Uint8Array(await file.arrayBuffer()) };
}

export async function pickImage() {
  const f = await pickFile('image/png,image/jpeg,image/webp,image/gif,image/bmp');
  if (!f) return null;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // normalize to PNG/JPEG data URL that pdf-lib can embed
      const c = document.createElement('canvas');
      const scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const isJpeg = /jpe?g/i.test(f.type);
      resolve({ src: c.toDataURL(isJpeg ? 'image/jpeg' : 'image/png', 0.92), w: c.width, h: c.height });
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(f);
  });
}

function toBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Saves bytes. Returns { path, label } or null if cancelled.
 *  desktop: overwrites `path` unless saveAs or no path -> Save dialog
 *  android: Documents/SwiftPDF/<name>
 *  web: browser download
 */
export async function saveFile(bytes, { name, path, saveAs }) {
  if (isDesktop) {
    if (path && !saveAs) {
      await desktop.saveFile(path, bytes);
      return { path, label: path };
    }
    const p = await desktop.saveDialog(name, bytes);
    return p ? { path: p, label: p } : null;
  }
  if (isAndroid) {
    const data = toBase64(bytes);
    let fileName = name;
    try {
      await Filesystem.writeFile({ path: `SwiftPDF/${fileName}`, data, directory: Directory.Documents, recursive: true });
    } catch {
      fileName = name.replace(/\.pdf$/i, '') + `-${Date.now()}.pdf`;
      await Filesystem.writeFile({ path: `SwiftPDF/${fileName}`, data, directory: Directory.Documents, recursive: true });
    }
    return { path: null, label: `Documents/SwiftPDF/${fileName}` };
  }
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  return { path: null, label: name };
}

export const canShare = isAndroid || (!isDesktop && !!navigator.canShare);

export async function shareFile(bytes, name) {
  if (isAndroid) {
    const res = await Filesystem.writeFile({ path: name, data: toBase64(bytes), directory: Directory.Cache });
    await Share.share({ title: name, files: [res.uri], dialogTitle: 'Share PDF' });
    return;
  }
  const file = new File([bytes], name, { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: name });
  else await saveFile(bytes, { name });
}

async function readUri(uri) {
  try {
    const res = await fetch(Capacitor.convertFileSrc(uri));
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
  } catch { /* fall through */ }
  const r = await Filesystem.readFile({ path: uri });
  return typeof r.data === 'string' ? fromBase64(r.data) : new Uint8Array(await r.data.arrayBuffer());
}

function nameFromUri(uri) {
  try {
    const last = decodeURIComponent(uri.split('/').pop() || '');
    const clean = last.split(':').pop().split('?')[0];
    return /\.pdf$/i.test(clean) ? clean : `${clean || 'document'}.pdf`;
  } catch { return 'document.pdf'; }
}

/** Wires "open with" from the OS. cb receives {name, path, data}. */
export async function initExternalOpen(cb) {
  if (isDesktop) {
    desktop.onOpenFile(cb);
    const pending = await desktop.getPendingFile();
    if (pending) cb(pending);
    return;
  }
  if (isAndroid) {
    const handle = async (url) => {
      if (!url || !/^(content|file):/i.test(url)) return;
      try { cb({ name: nameFromUri(url), path: null, data: await readUri(url) }); } catch (err) { console.error(err); }
    };
    App.addListener('appUrlOpen', ({ url }) => handle(url));
    const launch = await App.getLaunchUrl();
    if (launch?.url) handle(launch.url);
  }
}

export function onBackButton(handler) {
  if (isAndroid) App.addListener('backButton', handler);
}
export function exitApp() { if (isAndroid) App.exitApp(); }

export function setDirtyFlag(v) { if (isDesktop) desktop.setDirty(v); }
export function setWindowTitle(t) {
  document.title = t;
  if (isDesktop) desktop.setTitle(t);
}
